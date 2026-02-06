#include "../include/zdbdecode.h"
#include "json.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdarg.h>
#include <errno.h>
#include <ctype.h>
#include <sys/stat.h>

/* ZFS headers */
#include <sys/zfs_context.h>
#include <sys/spa.h>
#include <sys/dmu.h>
#include <sys/dnode.h>
#include <sys/blkptr.h>
#include <sys/dmu_objset.h>
#include <sys/dsl_dir.h>
#include <sys/dsl_dataset.h>
#include <sys/rrwlock.h>
#include <sys/zfs_znode.h>
#include <sys/sa.h>
#include <sys/zap.h>
#include <sys/zap_impl.h>
#include <sys/zfs_refcount.h>
#include <sys/vdev.h>
#include <sys/zio.h>
#include <sys/abd.h>
#include <libzpool.h>
#include <libzfs.h>

/* Build-time version info */
#ifndef ZDX_GIT_SHA
#define ZDX_GIT_SHA "unknown"
#endif

/* Opaque pool handle */
struct zdx_pool {
    char *name;
    spa_t *spa;
};

/* Global libzfs handle */
static libzfs_handle_t *g_zfs = NULL;

/*
 * Free a result structure
 */
void
zdx_free_result(zdx_result_t *r)
{
    if (!r)
        return;

    if (r->json) {
        free(r->json);
        r->json = NULL;
    }

    if (r->errmsg) {
        free(r->errmsg);
        r->errmsg = NULL;
    }

    r->len = 0;
    r->err = 0;
}

/*
 * Create an error result
 */
static zdx_result_t
make_error(int err, const char *fmt, ...)
{
    zdx_result_t result = {0};
    result.err = err;
    result.json = NULL;
    result.len = 0;

    char buf[256];
    va_list args;
    va_start(args, fmt);
    vsnprintf(buf, sizeof(buf), fmt, args);
    va_end(args);

    result.errmsg = strdup(buf);
    return result;
}

/*
 * Create a success result with JSON
 */
static zdx_result_t
make_success(char *json)
{
    zdx_result_t result = {0};
    result.err = 0;
    result.json = json;
    result.len = json ? strlen(json) : 0;
    result.errmsg = NULL;
    return result;
}

/*
 * Return a safe object type name
 */
static const char *
dmu_ot_name_safe(dmu_object_type_t type)
{
    if (!DMU_OT_IS_VALID(type)) {
        return "unknown";
    }

    if (type & DMU_OT_NEWTYPE) {
        dmu_object_byteswap_t bswap = DMU_OT_BYTESWAP(type);
        if (bswap < DMU_BSWAP_NUMFUNCS &&
            dmu_ot_byteswap[bswap].ob_name != NULL) {
            return dmu_ot_byteswap[bswap].ob_name;
        }
        return "newtype";
    }

    if (type >= DMU_OT_NUMTYPES) {
        return "unknown";
    }

    if (dmu_ot[type].ot_name == NULL) {
        return "unknown";
    }

    return dmu_ot[type].ot_name;
}

static char *
bytes_to_hex(const uint8_t *data, size_t len)
{
    static const char *hex = "0123456789abcdef";
    size_t out_len = len * 2;
    char *out = malloc(out_len + 1);
    if (!out)
        return NULL;

    for (size_t i = 0; i < len; i++) {
        out[i * 2] = hex[(data[i] >> 4) & 0xF];
        out[i * 2 + 1] = hex[data[i] & 0xF];
    }
    out[out_len] = '\0';
    return out;
}

static char *
numbers_preview(const void *data, uint64_t count, int int_len)
{
    uint64_t shown = count;
    if (shown > 8)
        shown = 8;

    size_t cap = 64 + shown * 24;
    char *out = malloc(cap);
    if (!out)
        return NULL;

    size_t used = 0;
    for (uint64_t i = 0; i < shown; i++) {
        int written = 0;
        switch (int_len) {
        case 1:
            written = snprintf(out + used, cap - used, "%u ",
                (unsigned)((const uint8_t *)data)[i]);
            break;
        case 2:
            written = snprintf(out + used, cap - used, "%u ",
                (unsigned)((const uint16_t *)data)[i]);
            break;
        case 4:
            written = snprintf(out + used, cap - used, "%u ",
                (unsigned)((const uint32_t *)data)[i]);
            break;
        case 8:
            written = snprintf(out + used, cap - used, "%llu ",
                (unsigned long long)((const uint64_t *)data)[i]);
            break;
        default:
            written = snprintf(out + used, cap - used, "? ");
            break;
        }

        if (written < 0 || (size_t)written >= cap - used) {
            out[used] = '\0';
            return out;
        }
        used += (size_t)written;
    }

    if (count > shown) {
        (void)snprintf(out + used, cap - used, "...");
    } else if (used > 0 && out[used - 1] == ' ') {
        out[used - 1] = '\0';
    }

    return out;
}

static const char *
dirent_type_name(uint64_t type)
{
    switch (type) {
    case 1:
        return "fifo";
    case 2:
        return "char";
    case 4:
        return "dir";
    case 6:
        return "block";
    case 8:
        return "file";
    case 10:
        return "symlink";
    case 12:
        return "socket";
    case 14:
        return "whiteout";
    default:
        return "unknown";
    }
}

static uint64_t
mode_to_dirent_type(uint64_t mode)
{
    if (S_ISFIFO(mode))
        return 1;
    if (S_ISCHR(mode))
        return 2;
    if (S_ISDIR(mode))
        return 4;
    if (S_ISBLK(mode))
        return 6;
    if (S_ISREG(mode))
        return 8;
    if (S_ISLNK(mode))
        return 10;
    if (S_ISSOCK(mode))
        return 12;
    return 0;
}

static char *
dup_range(const char *start, size_t len)
{
    char *out = malloc(len + 1);
    if (!out)
        return NULL;
    (void)memcpy(out, start, len);
    out[len] = '\0';
    return out;
}

static int
append_semantic_edge(char **array, int *count, uint64_t source,
    uint64_t target, const char *label, const char *kind, double confidence)
{
    char *label_json = json_string(label);
    char *kind_json = json_string(kind);
    if (!label_json || !kind_json) {
        free(label_json);
        free(kind_json);
        return -1;
    }

    char *item = json_format(
        "{\"source_obj\":%llu,\"target_obj\":%llu,\"label\":%s,"
        "\"kind\":%s,\"confidence\":%.2f}",
        (unsigned long long)source,
        (unsigned long long)target,
        label_json,
        kind_json,
        confidence);
    free(label_json);
    free(kind_json);

    if (!item)
        return -1;

    char *new_array = json_array_append(*array, item);
    free(item);
    if (!new_array)
        return -1;

    free(*array);
    *array = new_array;
    (*count)++;
    return 0;
}

/*
 * Initialize the library
 */
int
zdx_init(void)
{
    /* Initialize ZFS kernel context (SPA_MODE_READ is defined in sys/spa.h) */
    kernel_init(SPA_MODE_READ);

    /* Initialize libzfs */
    g_zfs = libzfs_init();
    if (g_zfs == NULL) {
        kernel_fini();
        return -1;
    }

    return 0;
}

/*
 * Finalize the library
 */
void
zdx_fini(void)
{
    if (g_zfs) {
        libzfs_fini(g_zfs);
        g_zfs = NULL;
    }

    kernel_fini();
}

/*
 * Open a pool via libzpool
 */
zdx_pool_t *
zdx_pool_open(const char *name, int *err)
{
    if (err)
        *err = 0;

    if (name == NULL) {
        if (err)
            *err = EINVAL;
        return NULL;
    }

    spa_t *spa = NULL;
    int rc = spa_open(name, &spa, FTAG);
    if (rc != 0) {
        if (err)
            *err = rc;
        return NULL;
    }

    zdx_pool_t *pool = calloc(1, sizeof (zdx_pool_t));
    if (!pool) {
        spa_close(spa, FTAG);
        if (err)
            *err = ENOMEM;
        return NULL;
    }

    pool->name = strdup(name);
    pool->spa = spa;
    return pool;
}

/*
 * Close a pool handle
 */
void
zdx_pool_close(zdx_pool_t *pool)
{
    if (!pool)
        return;

    if (pool->spa)
        spa_close(pool->spa, FTAG);

    free(pool->name);
    free(pool);
}

/*
 * Pool info (stub for now)
 */
zdx_result_t
zdx_pool_info(zdx_pool_t *pool)
{
    if (!pool)
        return make_error(EINVAL, "pool not open");

    return make_error(ENOSYS, "pool info not implemented");
}

/*
 * Pool vdevs (stub for now)
 */
zdx_result_t
zdx_pool_vdevs(zdx_pool_t *pool)
{
    if (!pool)
        return make_error(EINVAL, "pool not open");

    return make_error(ENOSYS, "pool vdevs not implemented");
}

/*
 * Pool datasets (stub for now)
 */
zdx_result_t
zdx_pool_datasets(zdx_pool_t *pool)
{
    if (!pool)
        return make_error(EINVAL, "pool not open");

    return make_error(ENOSYS, "pool datasets not implemented");
}

/*
 * List MOS objects with optional type filter + pagination
 */
zdx_result_t
zdx_mos_list_objects(zdx_pool_t *pool, int type_filter,
    uint64_t start, uint64_t limit)
{
    if (!pool || !pool->spa)
        return make_error(EINVAL, "pool not open");

    objset_t *mos = spa_meta_objset(pool->spa);
    if (!mos)
        return make_error(EINVAL, "failed to access MOS");

    char *array = json_array_start();
    if (!array)
        return make_error(ENOMEM, "failed to allocate JSON array");

    uint64_t object = start;
    uint64_t last_obj = 0;
    int count = 0;
    int err = 0;

    while (count < (int)limit) {
        err = dmu_object_next(mos, &object, B_FALSE, 0);
        if (err != 0)
            break;

        dmu_object_info_t doi;
        if (dmu_object_info(mos, object, &doi) != 0)
            continue;

        if (type_filter >= 0 &&
            doi.doi_type != (dmu_object_type_t)type_filter)
            continue;

        char *type_name = json_string(dmu_ot_name_safe(doi.doi_type));
        char *bonus_name = json_string(dmu_ot_name_safe(doi.doi_bonus_type));
        if (!type_name || !bonus_name) {
            free(type_name);
            free(bonus_name);
            free(array);
            return make_error(ENOMEM, "failed to allocate JSON strings");
        }

        char *item = json_format(
            "{\"id\":%llu,\"type\":%u,\"type_name\":%s,"
            "\"bonus_type\":%u,\"bonus_type_name\":%s}",
            (unsigned long long)object,
            (unsigned)doi.doi_type,
            type_name,
            (unsigned)doi.doi_bonus_type,
            bonus_name);
        free(type_name);
        free(bonus_name);

        if (!item) {
            free(array);
            return make_error(ENOMEM, "failed to allocate JSON item");
        }

        char *new_array = json_array_append(array, item);
        free(item);

        if (!new_array) {
            free(array);
            return make_error(ENOMEM, "failed to append JSON item");
        }

        free(array);
        array = new_array;
        count++;
        last_obj = object;
    }

    if (err != 0 && err != ENOENT && err != ESRCH && err != EXDEV) {
        free(array);
        return make_error(err, "dmu_object_next failed: %s", strerror(err));
    }

    char *objects_json = json_array_end(array, count > 0);
    free(array);
    if (!objects_json)
        return make_error(ENOMEM, "failed to finalize JSON array");

    int has_more = 0;
    if (count > 0 && count == (int)limit) {
        uint64_t peek = object;
        if (dmu_object_next(mos, &peek, B_FALSE, 0) == 0)
            has_more = 1;
    }

    char *next_json = has_more
        ? json_format("%llu", (unsigned long long)last_obj)
        : strdup("null");
    if (!next_json) {
        free(objects_json);
        return make_error(ENOMEM, "failed to allocate next cursor");
    }

    char *result = json_format(
        "{\"start\":%llu,\"limit\":%llu,\"count\":%d,"
        "\"next\":%s,\"objects\":%s}",
        (unsigned long long)start,
        (unsigned long long)limit,
        count,
        next_json,
        objects_json);
    free(next_json);
    free(objects_json);

    if (!result)
        return make_error(ENOMEM, "failed to allocate JSON result");

    return make_success(result);
}

/*
 * Get MOS object dnode metadata
 */
zdx_result_t
zdx_mos_get_object(zdx_pool_t *pool, uint64_t objid)
{
    if (!pool || !pool->spa)
        return make_error(EINVAL, "pool not open");

    objset_t *mos = spa_meta_objset(pool->spa);
    if (!mos)
        return make_error(EINVAL, "failed to access MOS");

    dnode_t *dn = NULL;
    int err = dnode_hold(mos, objid, FTAG, &dn);
    if (err != 0)
        return make_error(err, "dnode_hold failed for object %llu",
            (unsigned long long)objid);

    dmu_object_info_t doi;
    dmu_object_info_from_dnode(dn, &doi);

    dnode_phys_t *dnp = dn->dn_phys;
    if (!dnp) {
        dnode_rele(dn, FTAG);
        return make_error(EIO, "missing dnode phys for object %llu",
            (unsigned long long)objid);
    }

    char *type_name = json_string(dmu_ot_name_safe(doi.doi_type));
    char *bonus_name = json_string(dmu_ot_name_safe(doi.doi_bonus_type));
    if (!type_name || !bonus_name) {
        free(type_name);
        free(bonus_name);
        dnode_rele(dn, FTAG);
        return make_error(ENOMEM, "failed to allocate JSON strings");
    }

    uint64_t used_bytes = DN_USED_BYTES(dnp);
    uint64_t indirect_block_size = 1ULL << dnp->dn_indblkshift;
    int is_zap = (DMU_OT_BYTESWAP(doi.doi_type) == DMU_BSWAP_ZAP);

    char *bonus_decoded = strdup("null");
    if (!bonus_decoded) {
        free(type_name);
        free(bonus_name);
        dnode_rele(dn, FTAG);
        return make_error(ENOMEM, "failed to allocate bonus JSON");
    }

    char *edges = json_array_start();
    if (!edges) {
        free(bonus_decoded);
        free(type_name);
        free(bonus_name);
        dnode_rele(dn, FTAG);
        return make_error(ENOMEM, "failed to allocate edges array");
    }
    int edge_count = 0;

    if (doi.doi_bonus_type == DMU_OT_DSL_DIR &&
        dnp->dn_bonuslen >= sizeof (dsl_dir_phys_t)) {
        dsl_dir_phys_t *dd = (dsl_dir_phys_t *)DN_BONUS(dnp);
        free(bonus_decoded);
        bonus_decoded = json_format(
            "{"
            "\"kind\":\"dsl_dir\","
            "\"head_dataset_obj\":%llu,"
            "\"parent_dir_obj\":%llu,"
            "\"origin_obj\":%llu,"
            "\"child_dir_zapobj\":%llu,"
            "\"props_zapobj\":%llu"
            "}",
            (unsigned long long)dd->dd_head_dataset_obj,
            (unsigned long long)dd->dd_parent_obj,
            (unsigned long long)dd->dd_origin_obj,
            (unsigned long long)dd->dd_child_dir_zapobj,
            (unsigned long long)dd->dd_props_zapobj);

        if (!bonus_decoded) {
            free(edges);
            free(type_name);
            free(bonus_name);
            dnode_rele(dn, FTAG);
            return make_error(ENOMEM, "failed to allocate bonus JSON");
        }

        if (dd->dd_child_dir_zapobj != 0) {
            if (append_semantic_edge(&edges, &edge_count, objid,
                dd->dd_child_dir_zapobj, "child_dir_zapobj",
                "dsl_child_dir_zapobj", 1.0) != 0) {
                free(edges);
                free(bonus_decoded);
                free(type_name);
                free(bonus_name);
                dnode_rele(dn, FTAG);
                return make_error(ENOMEM, "failed to append edge");
            }
        }
        if (dd->dd_head_dataset_obj != 0) {
            if (append_semantic_edge(&edges, &edge_count, objid,
                dd->dd_head_dataset_obj, "head_dataset_obj",
                "dsl_head_dataset_obj", 1.0) != 0) {
                free(edges);
                free(bonus_decoded);
                free(type_name);
                free(bonus_name);
                dnode_rele(dn, FTAG);
                return make_error(ENOMEM, "failed to append edge");
            }
        }
        if (dd->dd_props_zapobj != 0) {
            if (append_semantic_edge(&edges, &edge_count, objid,
                dd->dd_props_zapobj, "props_zapobj",
                "dsl_props_zapobj", 1.0) != 0) {
                free(edges);
                free(bonus_decoded);
                free(type_name);
                free(bonus_name);
                dnode_rele(dn, FTAG);
                return make_error(ENOMEM, "failed to append edge");
            }
        }
        if (dd->dd_origin_obj != 0) {
            if (append_semantic_edge(&edges, &edge_count, objid,
                dd->dd_origin_obj, "origin_obj",
                "dsl_origin_obj", 1.0) != 0) {
                free(edges);
                free(bonus_decoded);
                free(type_name);
                free(bonus_name);
                dnode_rele(dn, FTAG);
                return make_error(ENOMEM, "failed to append edge");
            }
        }
        if (dd->dd_parent_obj != 0) {
            if (append_semantic_edge(&edges, &edge_count, objid,
                dd->dd_parent_obj, "parent_dir_obj",
                "dsl_parent_dir_obj", 1.0) != 0) {
                free(edges);
                free(bonus_decoded);
                free(type_name);
                free(bonus_name);
                dnode_rele(dn, FTAG);
                return make_error(ENOMEM, "failed to append edge");
            }
        }
    } else if (doi.doi_bonus_type == DMU_OT_DSL_DATASET &&
        dnp->dn_bonuslen >= sizeof (dsl_dataset_phys_t)) {
        dsl_dataset_phys_t *ds = (dsl_dataset_phys_t *)DN_BONUS(dnp);
        /* TODO: Decode more DSL dataset fields (objset, snapshots ZAP, etc.) */
        free(bonus_decoded);
        bonus_decoded = json_format(
            "{"
            "\"kind\":\"dsl_dataset\","
            "\"dir_obj\":%llu,"
            "\"prev_snap_obj\":%llu,"
            "\"next_snap_obj\":%llu,"
            "\"snapnames_zapobj\":%llu"
            "}",
            (unsigned long long)ds->ds_dir_obj,
            (unsigned long long)ds->ds_prev_snap_obj,
            (unsigned long long)ds->ds_next_snap_obj,
            (unsigned long long)ds->ds_snapnames_zapobj);

        if (!bonus_decoded) {
            free(edges);
            free(type_name);
            free(bonus_name);
            dnode_rele(dn, FTAG);
            return make_error(ENOMEM, "failed to allocate bonus JSON");
        }
    }

    char *edges_json = json_array_end(edges, edge_count > 0);
    free(edges);
    if (!edges_json) {
        free(bonus_decoded);
        free(type_name);
        free(bonus_name);
        dnode_rele(dn, FTAG);
        return make_error(ENOMEM, "failed to finalize edges JSON");
    }

    char *result = json_format(
        "{"
        "\"id\":%llu,"
        "\"type\":{\"id\":%u,\"name\":%s},"
        "\"bonus_type\":{\"id\":%u,\"name\":%s},"
        "\"is_zap\":%s,"
        "\"bonus_decoded\":%s,"
        "\"semantic_edges\":%s,"
        "\"nlevels\":%u,"
        "\"nblkptr\":%u,"
        "\"indblkshift\":%u,"
        "\"indirect_block_size\":%llu,"
        "\"data_block_size\":%u,"
        "\"metadata_block_size\":%u,"
        "\"bonus_size\":%llu,"
        "\"bonus_len\":%u,"
        "\"checksum\":%u,"
        "\"compress\":%u,"
        "\"flags\":%u,"
        "\"maxblkid\":%llu,"
        "\"used_bytes\":%llu,"
        "\"fill_count\":%llu,"
        "\"physical_blocks_512\":%llu,"
        "\"max_offset\":%llu,"
        "\"indirection\":%u,"
        "\"dnodesize\":%llu"
        "}",
        (unsigned long long)objid,
        (unsigned)doi.doi_type,
        type_name,
        (unsigned)doi.doi_bonus_type,
        bonus_name,
        is_zap ? "true" : "false",
        bonus_decoded,
        edges_json,
        (unsigned)dnp->dn_nlevels,
        (unsigned)dnp->dn_nblkptr,
        (unsigned)dnp->dn_indblkshift,
        (unsigned long long)indirect_block_size,
        (unsigned)doi.doi_data_block_size,
        (unsigned)doi.doi_metadata_block_size,
        (unsigned long long)doi.doi_bonus_size,
        (unsigned)dnp->dn_bonuslen,
        (unsigned)dnp->dn_checksum,
        (unsigned)dnp->dn_compress,
        (unsigned)dnp->dn_flags,
        (unsigned long long)dnp->dn_maxblkid,
        (unsigned long long)used_bytes,
        (unsigned long long)doi.doi_fill_count,
        (unsigned long long)doi.doi_physical_blocks_512,
        (unsigned long long)doi.doi_max_offset,
        (unsigned)doi.doi_indirection,
        (unsigned long long)doi.doi_dnodesize);

    free(bonus_decoded);
    free(edges_json);
    free(type_name);
    free(bonus_name);
    dnode_rele(dn, FTAG);

    if (!result)
        return make_error(ENOMEM, "failed to allocate JSON result");

    return make_success(result);
}

/*
 * Convert blkptr to JSON object
 */
static char *
blkptr_to_json(const blkptr_t *bp, int index, int is_spill)
{
    int is_hole = BP_IS_HOLE(bp);
    int is_embedded = BP_IS_EMBEDDED(bp);
    int is_gang = BP_IS_GANG(bp);
    int dedup = BP_GET_DEDUP(bp);
    int level = BP_GET_LEVEL(bp);
    int type = BP_GET_TYPE(bp);
    uint64_t lsize = BP_GET_LSIZE(bp);
    uint64_t psize = BP_GET_PSIZE(bp);
    uint64_t asize = BP_GET_ASIZE(bp);
    uint64_t birth = BP_GET_BIRTH(bp);
    uint64_t logical_birth = BP_GET_LOGICAL_BIRTH(bp);
    uint64_t physical_birth = BP_GET_PHYSICAL_BIRTH(bp);
    uint64_t fill = BP_GET_FILL(bp);
    int checksum = BP_GET_CHECKSUM(bp);
    int compress = BP_GET_COMPRESS(bp);
    int ndvas = BP_GET_NDVAS(bp);

    char *dvas = json_array_start();
    if (!dvas)
        return NULL;

    int dva_count = 0;
    for (int i = 0; i < SPA_DVAS_PER_BP; i++) {
        const dva_t *dva = &bp->blk_dva[i];
        if (!DVA_IS_VALID(dva))
            continue;

        char *item = json_format(
            "{\"vdev\":%llu,\"offset\":%llu,\"asize\":%llu,"
            "\"is_gang\":%s}",
            (unsigned long long)DVA_GET_VDEV(dva),
            (unsigned long long)DVA_GET_OFFSET(dva),
            (unsigned long long)DVA_GET_ASIZE(dva),
            DVA_GET_GANG(dva) ? "true" : "false");
        if (!item) {
            free(dvas);
            return NULL;
        }

        char *new_dvas = json_array_append(dvas, item);
        free(item);
        if (!new_dvas) {
            free(dvas);
            return NULL;
        }

        free(dvas);
        dvas = new_dvas;
        dva_count++;
    }

    char *dvas_json = json_array_end(dvas, dva_count > 0);
    free(dvas);
    if (!dvas_json)
        return NULL;

    char *result = json_format(
        "{"
        "\"index\":%d,"
        "\"is_spill\":%s,"
        "\"is_hole\":%s,"
        "\"is_embedded\":%s,"
        "\"is_gang\":%s,"
        "\"level\":%d,"
        "\"type\":%d,"
        "\"lsize\":%llu,"
        "\"psize\":%llu,"
        "\"asize\":%llu,"
        "\"birth_txg\":%llu,"
        "\"logical_birth\":%llu,"
        "\"physical_birth\":%llu,"
        "\"fill\":%llu,"
        "\"checksum\":%d,"
        "\"compression\":%d,"
        "\"dedup\":%s,"
        "\"ndvas\":%d,"
        "\"dvas\":%s"
        "}",
        index,
        is_spill ? "true" : "false",
        is_hole ? "true" : "false",
        is_embedded ? "true" : "false",
        is_gang ? "true" : "false",
        level,
        type,
        (unsigned long long)lsize,
        (unsigned long long)psize,
        (unsigned long long)asize,
        (unsigned long long)birth,
        (unsigned long long)logical_birth,
        (unsigned long long)physical_birth,
        (unsigned long long)fill,
        checksum,
        compress,
        dedup ? "true" : "false",
        ndvas,
        dvas_json);

    free(dvas_json);
    return result;
}

/*
 * Get MOS object blkptrs
 */
zdx_result_t
zdx_mos_get_blkptrs(zdx_pool_t *pool, uint64_t objid)
{
    if (!pool || !pool->spa)
        return make_error(EINVAL, "pool not open");

    objset_t *mos = spa_meta_objset(pool->spa);
    if (!mos)
        return make_error(EINVAL, "failed to access MOS");

    dnode_t *dn = NULL;
    int err = dnode_hold(mos, objid, FTAG, &dn);
    if (err != 0)
        return make_error(err, "dnode_hold failed for object %llu",
            (unsigned long long)objid);

    dnode_phys_t *dnp = dn->dn_phys;
    if (!dnp) {
        dnode_rele(dn, FTAG);
        return make_error(EIO, "missing dnode phys for object %llu",
            (unsigned long long)objid);
    }

    char *array = json_array_start();
    if (!array) {
        dnode_rele(dn, FTAG);
        return make_error(ENOMEM, "failed to allocate JSON array");
    }

    int count = 0;
    for (int i = 0; i < dnp->dn_nblkptr; i++) {
        blkptr_t *bp = &dnp->dn_blkptr[i];
        char *item = blkptr_to_json(bp, i, 0);
        if (!item) {
            free(array);
            dnode_rele(dn, FTAG);
            return make_error(ENOMEM, "failed to build blkptr JSON");
        }

        char *new_array = json_array_append(array, item);
        free(item);
        if (!new_array) {
            free(array);
            dnode_rele(dn, FTAG);
            return make_error(ENOMEM, "failed to append blkptr JSON");
        }

        free(array);
        array = new_array;
        count++;
    }

    int has_spill = (dnp->dn_flags & DNODE_FLAG_SPILL_BLKPTR) != 0;
    if (has_spill) {
        blkptr_t *spill = DN_SPILL_BLKPTR(dnp);
        char *item = blkptr_to_json(spill, dnp->dn_nblkptr, 1);
        if (!item) {
            free(array);
            dnode_rele(dn, FTAG);
            return make_error(ENOMEM, "failed to build spill blkptr JSON");
        }

        char *new_array = json_array_append(array, item);
        free(item);
        if (!new_array) {
            free(array);
            dnode_rele(dn, FTAG);
            return make_error(ENOMEM, "failed to append spill blkptr JSON");
        }

        free(array);
        array = new_array;
        count++;
    }

    char *blkptrs_json = json_array_end(array, count > 0);
    free(array);
    if (!blkptrs_json) {
        dnode_rele(dn, FTAG);
        return make_error(ENOMEM, "failed to finalize blkptrs JSON");
    }

    char *result = json_format(
        "{"
        "\"id\":%llu,"
        "\"nblkptr\":%u,"
        "\"has_spill\":%s,"
        "\"blkptrs\":%s"
        "}",
        (unsigned long long)objid,
        (unsigned)dnp->dn_nblkptr,
        has_spill ? "true" : "false",
        blkptrs_json);
    free(blkptrs_json);
    dnode_rele(dn, FTAG);

    if (!result)
        return make_error(ENOMEM, "failed to allocate JSON result");

    return make_success(result);
}

/*
 * Unified object fetch: dnode + blkptrs + optional ZAP
 */
zdx_result_t
zdx_obj_get(zdx_pool_t *pool, uint64_t objid)
{
    zdx_result_t obj = zdx_mos_get_object(pool, objid);
    if (obj.err != 0)
        return obj;

    zdx_result_t blk = zdx_mos_get_blkptrs(pool, objid);
    if (blk.err != 0) {
        zdx_free_result(&obj);
        return blk;
    }

    /* Determine if this is a ZAP object by inspecting the object JSON. */
    boolean_t is_zap = B_FALSE;
    if (obj.json != NULL && strstr(obj.json, "\"is_zap\":true") != NULL)
        is_zap = B_TRUE;

    zdx_result_t zinfo = {0};
    zdx_result_t zents = {0};
    if (is_zap) {
        zinfo = zdx_zap_info(pool, objid);
        if (zinfo.err != 0) {
            zdx_free_result(&obj);
            zdx_free_result(&blk);
            return zinfo;
        }
        zents = zdx_zap_entries(pool, objid, 0, 200);
        if (zents.err != 0) {
            zdx_free_result(&obj);
            zdx_free_result(&blk);
            zdx_free_result(&zinfo);
            return zents;
        }
    }

    const char *zap_info_json = is_zap ? zinfo.json : "null";
    const char *zap_entries_json = is_zap ? zents.json : "null";

    char *result = json_format(
        "{"
        "\"object\":%s,"
        "\"blkptrs\":%s,"
        "\"zap_info\":%s,"
        "\"zap_entries\":%s"
        "}",
        obj.json,
        blk.json,
        zap_info_json,
        zap_entries_json);

    zdx_free_result(&obj);
    zdx_free_result(&blk);
    if (is_zap) {
        zdx_free_result(&zinfo);
        zdx_free_result(&zents);
    }

    if (!result)
        return make_error(ENOMEM, "failed to allocate JSON result");

    return make_success(result);
}

/*
 * DSL dir children
 */
zdx_result_t
zdx_dsl_dir_children(zdx_pool_t *pool, uint64_t objid)
{
    if (!pool || !pool->spa)
        return make_error(EINVAL, "pool not open");

    objset_t *mos = spa_meta_objset(pool->spa);
    if (!mos)
        return make_error(EINVAL, "failed to access MOS");

    dnode_t *dn = NULL;
    int err = dnode_hold(mos, objid, FTAG, &dn);
    if (err != 0)
        return make_error(err, "dnode_hold failed for object %llu",
            (unsigned long long)objid);

    dmu_object_info_t doi;
    dmu_object_info_from_dnode(dn, &doi);

    if (doi.doi_bonus_type != DMU_OT_DSL_DIR ||
        dn->dn_bonuslen < sizeof (dsl_dir_phys_t)) {
        dnode_rele(dn, FTAG);
        return make_error(EINVAL, "object %llu is not DSL dir",
            (unsigned long long)objid);
    }

    dsl_dir_phys_t *dd = (dsl_dir_phys_t *)DN_BONUS(dn->dn_phys);
    uint64_t zapobj = dd->dd_child_dir_zapobj;
    dnode_rele(dn, FTAG);

    char *array = json_array_start();
    if (!array)
        return make_error(ENOMEM, "failed to allocate JSON array");
    int count = 0;

    if (zapobj != 0) {
        zap_cursor_t zc;
        zap_cursor_init(&zc, mos, zapobj);
        zap_attribute_t *attrp = zap_attribute_long_alloc();
        if (!attrp) {
            zap_cursor_fini(&zc);
            free(array);
            return make_error(ENOMEM, "failed to allocate zap attribute");
        }

        while ((err = zap_cursor_retrieve(&zc, attrp)) == 0) {
            uint64_t child_obj = 0;
            if (attrp->za_integer_length == 8 &&
                attrp->za_num_integers == 1) {
                (void) zap_lookup(mos, zapobj, attrp->za_name,
                    8, 1, &child_obj);
            }

            // Skip entries with invalid object IDs
            if (child_obj == 0) {
                zap_cursor_advance(&zc);
                continue;
            }

            // Validate that the child object exists and is a DSL directory
            dnode_t *child_dn = NULL;
            int child_err = dnode_hold(mos, child_obj, FTAG, &child_dn);
            if (child_err != 0) {
                // Skip non-existent objects
                zap_cursor_advance(&zc);
                continue;
            }

            dmu_object_info_t child_doi;
            dmu_object_info_from_dnode(child_dn, &child_doi);
            dnode_rele(child_dn, FTAG);

            // Skip if not a DSL directory
            if (child_doi.doi_bonus_type != DMU_OT_DSL_DIR) {
                zap_cursor_advance(&zc);
                continue;
            }

            char *name_json = json_string(attrp->za_name);
            if (!name_json) {
                zap_attribute_free(attrp);
                zap_cursor_fini(&zc);
                free(array);
                return make_error(ENOMEM, "failed to allocate name");
            }

            char *item = json_format(
                "{\"name\":%s,\"dir_objid\":%llu}",
                name_json,
                (unsigned long long)child_obj);
            free(name_json);
            if (!item) {
                zap_attribute_free(attrp);
                zap_cursor_fini(&zc);
                free(array);
                return make_error(ENOMEM, "failed to allocate JSON item");
            }

            char *new_array = json_array_append(array, item);
            free(item);
            if (!new_array) {
                zap_attribute_free(attrp);
                zap_cursor_fini(&zc);
                free(array);
                return make_error(ENOMEM, "failed to append JSON item");
            }
            free(array);
            array = new_array;
            count++;

            zap_cursor_advance(&zc);
        }

        if (err != 0 && err != ENOENT) {
            zap_attribute_free(attrp);
            zap_cursor_fini(&zc);
            free(array);
            return make_error(err, "zap_cursor_retrieve failed: %s",
                strerror(err));
        }

        zap_attribute_free(attrp);
        zap_cursor_fini(&zc);
    }

    char *children_json = json_array_end(array, count > 0);
    free(array);
    if (!children_json)
        return make_error(ENOMEM, "failed to finalize JSON array");

    char *result = json_format(
        "{"
        "\"dir_objid\":%llu,"
        "\"child_dir_zapobj\":%llu,"
        "\"children\":%s"
        "}",
        (unsigned long long)objid,
        (unsigned long long)zapobj,
        children_json);
    free(children_json);

    if (!result)
        return make_error(ENOMEM, "failed to allocate JSON result");

    return make_success(result);
}

/*
 * DSL dir head dataset
 */
zdx_result_t
zdx_dsl_dir_head(zdx_pool_t *pool, uint64_t objid)
{
    if (!pool || !pool->spa)
        return make_error(EINVAL, "pool not open");

    objset_t *mos = spa_meta_objset(pool->spa);
    if (!mos)
        return make_error(EINVAL, "failed to access MOS");

    dnode_t *dn = NULL;
    int err = dnode_hold(mos, objid, FTAG, &dn);
    if (err != 0)
        return make_error(err, "dnode_hold failed for object %llu",
            (unsigned long long)objid);

    dmu_object_info_t doi;
    dmu_object_info_from_dnode(dn, &doi);
    if (doi.doi_bonus_type != DMU_OT_DSL_DIR ||
        dn->dn_bonuslen < sizeof (dsl_dir_phys_t)) {
        dnode_rele(dn, FTAG);
        return make_error(EINVAL, "object %llu is not DSL dir",
            (unsigned long long)objid);
    }

    dsl_dir_phys_t *dd = (dsl_dir_phys_t *)DN_BONUS(dn->dn_phys);
    uint64_t head = dd->dd_head_dataset_obj;
    dnode_rele(dn, FTAG);

    char *result = json_format(
        "{\"dir_objid\":%llu,\"head_dataset_obj\":%llu}",
        (unsigned long long)objid,
        (unsigned long long)head);

    if (!result)
        return make_error(ENOMEM, "failed to allocate JSON result");

    return make_success(result);
}

/*
 * DSL root dir discovery
 */
zdx_result_t
zdx_dsl_root_dir(zdx_pool_t *pool)
{
    if (!pool || !pool->spa)
        return make_error(EINVAL, "pool not open");

    objset_t *mos = spa_meta_objset(pool->spa);
    if (!mos)
        return make_error(EINVAL, "failed to access MOS");

    // Note: DMU_POOL_ROOT_DATASET actually points to the root *directory* object,
    // not a dataset. This is confusing OpenZFS naming.
    uint64_t root_dir = 0;
    int err = zap_lookup(mos, DMU_POOL_DIRECTORY_OBJECT,
        DMU_POOL_ROOT_DATASET, 8, 1, &root_dir);
    if (err != 0)
        return make_error(err, "failed to lookup root_dataset: %s",
            strerror(err));

    // Read the directory's head_dataset_obj to get the actual root dataset
    dmu_buf_t *db = NULL;
    err = dmu_bonus_hold(mos, root_dir, FTAG, &db);
    if (err != 0)
        return make_error(err, "dmu_bonus_hold failed for root dir %llu",
            (unsigned long long)root_dir);

    if (db->db_size < sizeof (dsl_dir_phys_t)) {
        dmu_buf_rele(db, FTAG);
        return make_error(EINVAL, "root dir bonus too small");
    }

    dsl_dir_phys_t *dd = (dsl_dir_phys_t *)db->db_data;
    uint64_t root_dataset = dd->dd_head_dataset_obj;
    dmu_buf_rele(db, FTAG);

    char *result = json_format(
        "{"
        "\"root_dataset_obj\":%llu,"
        "\"root_dir_obj\":%llu"
        "}",
        (unsigned long long)root_dataset,
        (unsigned long long)root_dir);

    if (!result)
        return make_error(ENOMEM, "failed to allocate JSON result");

    return make_success(result);
}

/*
 * Dataset -> objset resolution
 */
zdx_result_t
zdx_dataset_objset(zdx_pool_t *pool, uint64_t dsobj)
{
    if (!pool || !pool->spa)
        return make_error(EINVAL, "pool not open");

    spa_t *spa = pool->spa;
    dsl_dataset_t *ds = NULL;
    objset_t *os = NULL;
    int err;

    dsl_pool_config_enter(spa->spa_dsl_pool, FTAG);
    err = dsl_dataset_hold_obj(spa->spa_dsl_pool, dsobj, FTAG, &ds);
    if (err != 0) {
        dsl_pool_config_exit(spa->spa_dsl_pool, FTAG);
        return make_error(err, "dsl_dataset_hold_obj failed: %s",
            strerror(err));
    }

    err = dmu_objset_from_ds(ds, &os);
    if (err != 0) {
        dsl_dataset_rele(ds, FTAG);
        dsl_pool_config_exit(spa->spa_dsl_pool, FTAG);
        return make_error(err, "dmu_objset_from_ds failed: %s",
            strerror(err));
    }

    uint64_t objset_id = dmu_objset_id(os);

    blkptr_t rootbp;
    rrw_enter(&ds->ds_bp_rwlock, RW_READER, FTAG);
    rootbp = dsl_dataset_phys(ds)->ds_bp;
    rrw_exit(&ds->ds_bp_rwlock, FTAG);

    dsl_dataset_rele(ds, FTAG);
    dsl_pool_config_exit(spa->spa_dsl_pool, FTAG);

    char *rootbp_json = blkptr_to_json(&rootbp, 0, 0);
    if (!rootbp_json)
        return make_error(ENOMEM, "failed to encode rootbp");

    char *result = json_format(
        "{"
        "\"dataset_obj\":%llu,"
        "\"objset_id\":%llu,"
        "\"rootbp\":%s"
        "}",
        (unsigned long long)dsobj,
        (unsigned long long)objset_id,
        rootbp_json);
    free(rootbp_json);

    if (!result)
        return make_error(ENOMEM, "failed to allocate JSON result");

    return make_success(result);
}

/*
 * Objset -> root znode
 */
zdx_result_t
zdx_objset_root(zdx_pool_t *pool, uint64_t objset_id)
{
    if (!pool || !pool->spa)
        return make_error(EINVAL, "pool not open");

    spa_t *spa = pool->spa;
    dsl_dataset_t *ds = NULL;
    objset_t *os = NULL;
    int err;

    dsl_pool_config_enter(spa->spa_dsl_pool, FTAG);
    err = dsl_dataset_hold_obj(spa->spa_dsl_pool, objset_id, FTAG, &ds);
    if (err != 0) {
        dsl_pool_config_exit(spa->spa_dsl_pool, FTAG);
        return make_error(err, "dsl_dataset_hold_obj failed: %s",
            strerror(err));
    }

    err = dmu_objset_from_ds(ds, &os);
    if (err != 0) {
        dsl_dataset_rele(ds, FTAG);
        dsl_pool_config_exit(spa->spa_dsl_pool, FTAG);
        return make_error(err, "dmu_objset_from_ds failed: %s",
            strerror(err));
    }

    if (dmu_objset_type(os) != DMU_OST_ZFS) {
        dsl_dataset_rele(ds, FTAG);
        dsl_pool_config_exit(spa->spa_dsl_pool, FTAG);
        return make_error(EINVAL, "objset is not ZFS (type %d)",
            dmu_objset_type(os));
    }

    uint64_t root_obj = 0;
    err = zap_lookup(os, MASTER_NODE_OBJ, ZFS_ROOT_OBJ, 8, 1, &root_obj);
    dsl_dataset_rele(ds, FTAG);
    dsl_pool_config_exit(spa->spa_dsl_pool, FTAG);
    if (err != 0)
        return make_error(err, "zap_lookup ROOT failed: %s", strerror(err));

    char *result = json_format(
        "{"
        "\"objset_id\":%llu,"
        "\"root_obj\":%llu"
        "}",
        (unsigned long long)objset_id,
        (unsigned long long)root_obj);

    if (!result)
        return make_error(ENOMEM, "failed to allocate JSON result");

    return make_success(result);
}

/*
 * Directory listing (ZPL): list entries for a directory znode object.
 */
zdx_result_t
zdx_objset_dir_entries(zdx_pool_t *pool, uint64_t objset_id,
    uint64_t dir_obj, uint64_t cursor, uint64_t limit)
{
    if (!pool || !pool->spa)
        return make_error(EINVAL, "pool not open");

    if (limit == 0)
        limit = 200;

    spa_t *spa = pool->spa;
    dsl_dataset_t *ds = NULL;
    objset_t *os = NULL;
    int err;

    dsl_pool_config_enter(spa->spa_dsl_pool, FTAG);
    err = dsl_dataset_hold_obj(spa->spa_dsl_pool, objset_id, FTAG, &ds);
    if (err != 0) {
        dsl_pool_config_exit(spa->spa_dsl_pool, FTAG);
        return make_error(err, "dsl_dataset_hold_obj failed: %s",
            strerror(err));
    }

    err = dmu_objset_from_ds(ds, &os);
    if (err != 0) {
        dsl_dataset_rele(ds, FTAG);
        dsl_pool_config_exit(spa->spa_dsl_pool, FTAG);
        return make_error(err, "dmu_objset_from_ds failed: %s",
            strerror(err));
    }

    if (dmu_objset_type(os) != DMU_OST_ZFS) {
        dsl_dataset_rele(ds, FTAG);
        dsl_pool_config_exit(spa->spa_dsl_pool, FTAG);
        return make_error(EINVAL, "objset is not ZFS (type %d)",
            dmu_objset_type(os));
    }

    zap_cursor_t zc;
    zap_cursor_init_serialized(&zc, os, dir_obj, cursor);
    zap_attribute_t *attrp = zap_attribute_long_alloc();
    if (!attrp) {
        zap_cursor_fini(&zc);
        dsl_dataset_rele(ds, FTAG);
        dsl_pool_config_exit(spa->spa_dsl_pool, FTAG);
        return make_error(ENOMEM, "failed to allocate zap attribute");
    }

    char *array = json_array_start();
    if (!array) {
        zap_attribute_free(attrp);
        zap_cursor_fini(&zc);
        dsl_dataset_rele(ds, FTAG);
        dsl_pool_config_exit(spa->spa_dsl_pool, FTAG);
        return make_error(ENOMEM, "failed to allocate JSON array");
    }

    uint64_t count = 0;
    int done = 0;
    while (count < limit) {
        err = zap_cursor_retrieve(&zc, attrp);
        if (err == ENOENT) {
            done = 1;
            break;
        }
        if (err != 0) {
            free(array);
            zap_attribute_free(attrp);
            zap_cursor_fini(&zc);
            dsl_dataset_rele(ds, FTAG);
            dsl_pool_config_exit(spa->spa_dsl_pool, FTAG);
            return make_error(err, "zap_cursor_retrieve failed: %s",
                strerror(err));
        }

        uint64_t dirent = 0;
        if (attrp->za_integer_length == 8 &&
            attrp->za_num_integers == 1) {
            (void) zap_lookup(os, dir_obj, attrp->za_name, 8, 1, &dirent);
        }

        uint64_t child_obj = ZFS_DIRENT_OBJ(dirent);
        uint64_t dtype = ZFS_DIRENT_TYPE(dirent);
        const char *dtype_name = dirent_type_name(dtype);

        char *name_json = json_string(attrp->za_name);
        if (!name_json) {
            free(array);
            zap_attribute_free(attrp);
            zap_cursor_fini(&zc);
            dsl_dataset_rele(ds, FTAG);
            dsl_pool_config_exit(spa->spa_dsl_pool, FTAG);
            return make_error(ENOMEM, "failed to allocate name");
        }

        char *item = json_format(
            "{"
            "\"name\":%s,"
            "\"objid\":%llu,"
            "\"type\":%llu,"
            "\"type_name\":\"%s\""
            "}",
            name_json,
            (unsigned long long)child_obj,
            (unsigned long long)dtype,
            dtype_name);
        free(name_json);
        if (!item) {
            free(array);
            zap_attribute_free(attrp);
            zap_cursor_fini(&zc);
            dsl_dataset_rele(ds, FTAG);
            dsl_pool_config_exit(spa->spa_dsl_pool, FTAG);
            return make_error(ENOMEM, "failed to allocate JSON item");
        }

        char *new_array = json_array_append(array, item);
        free(item);
        if (!new_array) {
            free(array);
            zap_attribute_free(attrp);
            zap_cursor_fini(&zc);
            dsl_dataset_rele(ds, FTAG);
            dsl_pool_config_exit(spa->spa_dsl_pool, FTAG);
            return make_error(ENOMEM, "failed to append JSON item");
        }

        free(array);
        array = new_array;
        count++;
        zap_cursor_advance(&zc);
    }

    char *entries_json = json_array_end(array, count > 0);
    free(array);
    if (!entries_json) {
        zap_attribute_free(attrp);
        zap_cursor_fini(&zc);
        dsl_dataset_rele(ds, FTAG);
        dsl_pool_config_exit(spa->spa_dsl_pool, FTAG);
        return make_error(ENOMEM, "failed to finalize JSON array");
    }

    uint64_t next = 0;
    if (!done)
        next = zap_cursor_serialize(&zc);

    char next_buf[32];
    const char *next_json = "null";
    if (!done) {
        (void)snprintf(next_buf, sizeof (next_buf), "%llu",
            (unsigned long long)next);
        next_json = next_buf;
    }

    char *result = json_format(
        "{"
        "\"objset_id\":%llu,"
        "\"dir_obj\":%llu,"
        "\"cursor\":%llu,"
        "\"next\":%s,"
        "\"count\":%llu,"
        "\"entries\":%s"
        "}",
        (unsigned long long)objset_id,
        (unsigned long long)dir_obj,
        (unsigned long long)cursor,
        next_json,
        (unsigned long long)count,
        entries_json);

    free(entries_json);
    zap_attribute_free(attrp);
    zap_cursor_fini(&zc);
    dsl_dataset_rele(ds, FTAG);
    dsl_pool_config_exit(spa->spa_dsl_pool, FTAG);

    if (!result)
        return make_error(ENOMEM, "failed to allocate JSON result");

    return make_success(result);
}

/*
 * Path walk within a ZPL objset.
 */
zdx_result_t
zdx_objset_walk(zdx_pool_t *pool, uint64_t objset_id, const char *path)
{
    if (!pool || !pool->spa)
        return make_error(EINVAL, "pool not open");

    if (!path)
        return make_error(EINVAL, "path is null");

    const char *input_path = path;
    if (input_path[0] == '\0')
        input_path = "/";

    spa_t *spa = pool->spa;
    dsl_dataset_t *ds = NULL;
    objset_t *os = NULL;
    int err;
    int config_entered = 0;
    zdx_result_t result;
    char *resolved = NULL;
    char *remaining = NULL;
    char *path_json = NULL;
    char *resolved_json = NULL;
    char *remaining_json = NULL;
    char *error_json = NULL;
    const char *error_kind = NULL;

    dsl_pool_config_enter(spa->spa_dsl_pool, FTAG);
    config_entered = 1;
    err = dsl_dataset_hold_obj(spa->spa_dsl_pool, objset_id, FTAG, &ds);
    if (err != 0) {
        result = make_error(err, "dsl_dataset_hold_obj failed: %s",
            strerror(err));
        goto out;
    }

    err = dmu_objset_from_ds(ds, &os);
    if (err != 0) {
        result = make_error(err, "dmu_objset_from_ds failed: %s",
            strerror(err));
        goto out;
    }

    if (dmu_objset_type(os) != DMU_OST_ZFS) {
        result = make_error(EINVAL, "objset is not ZFS (type %d)",
            dmu_objset_type(os));
        goto out;
    }

    uint64_t root_obj = 0;
    err = zap_lookup(os, MASTER_NODE_OBJ, ZFS_ROOT_OBJ, 8, 1, &root_obj);
    if (err != 0) {
        result = make_error(err, "zap_lookup ROOT failed: %s", strerror(err));
        goto out;
    }

    const char *p = input_path;
    while (*p == '/')
        p++;

    if (*p == '\0') {
        resolved = strdup("/");
        remaining = strdup("");
        if (!resolved || !remaining) {
            result = make_error(ENOMEM, "failed to allocate path strings");
            goto out;
        }
        uint64_t dtype = 4;
        const char *dtype_name = dirent_type_name(dtype);
        path_json = json_string(input_path);
        resolved_json = json_string(resolved);
        remaining_json = json_string(remaining);
        if (!path_json || !resolved_json || !remaining_json) {
            result = make_error(ENOMEM, "failed to encode JSON strings");
            goto out;
        }

        char *json = json_format(
            "{"
            "\"objset_id\":%llu,"
            "\"path\":%s,"
            "\"root_obj\":%llu,"
            "\"resolved\":%s,"
            "\"remaining\":%s,"
            "\"objid\":%llu,"
            "\"type\":%llu,"
            "\"type_name\":\"%s\","
            "\"found\":true,"
            "\"error\":null"
            "}",
            (unsigned long long)objset_id,
            path_json,
            (unsigned long long)root_obj,
            resolved_json,
            remaining_json,
            (unsigned long long)root_obj,
            (unsigned long long)dtype,
            dtype_name);
        if (!json) {
            result = make_error(ENOMEM, "failed to allocate JSON result");
            goto out;
        }
        result = make_success(json);
        goto out;
    }

    size_t cap = strlen(input_path) + 2;
    resolved = malloc(cap);
    if (!resolved) {
        result = make_error(ENOMEM, "failed to allocate resolved path");
        goto out;
    }
    resolved[0] = '/';
    resolved[1] = '\0';
    size_t resolved_len = 1;

    uint64_t current = root_obj;
    uint64_t current_type = 4;
    const char *current_type_name = dirent_type_name(current_type);
    int found = 1;

    while (*p) {
        while (*p == '/')
            p++;
        if (*p == '\0')
            break;
        const char *start = p;
        while (*p && *p != '/')
            p++;
        size_t len = (size_t)(p - start);
        if (len == 0)
            continue;

        char *name = dup_range(start, len);
        if (!name) {
            result = make_error(ENOMEM, "failed to allocate path component");
            goto out;
        }

        uint64_t dirent = 0;
        err = zap_lookup(os, current, name, 8, 1, &dirent);
        if (err != 0) {
            free(name);
            found = 0;
            error_kind = "not_found";
            remaining = strdup(start);
            break;
        }

        uint64_t child_obj = ZFS_DIRENT_OBJ(dirent);
        uint64_t dtype = ZFS_DIRENT_TYPE(dirent);
        const char *dtype_name = dirent_type_name(dtype);

        if (resolved_len + len + 2 > cap) {
            size_t new_cap = resolved_len + len + 2;
            char *new_resolved = realloc(resolved, new_cap);
            if (!new_resolved) {
                free(name);
                result = make_error(ENOMEM, "failed to grow resolved path");
                goto out;
            }
            resolved = new_resolved;
            cap = new_cap;
        }

        if (resolved_len > 1) {
            resolved[resolved_len] = '/';
            resolved_len++;
        }
        (void)memcpy(resolved + resolved_len, name, len);
        resolved_len += len;
        resolved[resolved_len] = '\0';

        free(name);

        const char *next = p;
        while (*next == '/')
            next++;

        current = child_obj;
        current_type = dtype;
        current_type_name = dtype_name;

        if (*next != '\0' && dtype != 4) {
            found = 0;
            error_kind = "not_dir";
            remaining = strdup(next);
            break;
        }

        p = next;
    }

    if (!remaining) {
        remaining = strdup("");
    }

    if (!resolved || !remaining) {
        result = make_error(ENOMEM, "failed to allocate path strings");
        goto out;
    }

    path_json = json_string(input_path);
    resolved_json = json_string(resolved);
    remaining_json = json_string(remaining);
    if (!path_json || !resolved_json || !remaining_json) {
        result = make_error(ENOMEM, "failed to encode JSON strings");
        goto out;
    }

    const char *error_field = "null";
    if (error_kind) {
        error_json = json_string(error_kind);
        if (!error_json) {
            result = make_error(ENOMEM, "failed to encode error string");
            goto out;
        }
        error_field = error_json;
    }

    char *json = json_format(
        "{"
        "\"objset_id\":%llu,"
        "\"path\":%s,"
        "\"root_obj\":%llu,"
        "\"resolved\":%s,"
        "\"remaining\":%s,"
        "\"objid\":%llu,"
        "\"type\":%llu,"
        "\"type_name\":\"%s\","
        "\"found\":%s,"
        "\"error\":%s"
        "}",
        (unsigned long long)objset_id,
        path_json,
        (unsigned long long)root_obj,
        resolved_json,
        remaining_json,
        (unsigned long long)current,
        (unsigned long long)current_type,
        current_type_name,
        found ? "true" : "false",
        error_field);
    if (!json) {
        result = make_error(ENOMEM, "failed to allocate JSON result");
        goto out;
    }

    result = make_success(json);

out:
    if (ds)
        dsl_dataset_rele(ds, FTAG);
    if (config_entered)
        dsl_pool_config_exit(spa->spa_dsl_pool, FTAG);
    free(resolved);
    free(remaining);
    free(path_json);
    free(resolved_json);
    free(remaining_json);
    free(error_json);
    return result;
}

/*
 * ZPL stat for a znode object.
 */
zdx_result_t
zdx_objset_stat(zdx_pool_t *pool, uint64_t objset_id, uint64_t objid)
{
    if (!pool || !pool->spa)
        return make_error(EINVAL, "pool not open");

    spa_t *spa = pool->spa;
    dsl_dataset_t *ds = NULL;
    objset_t *os = NULL;
    int err;
    int config_entered = 0;
    zdx_result_t result;

    dsl_pool_config_enter(spa->spa_dsl_pool, FTAG);
    config_entered = 1;
    err = dsl_dataset_hold_obj(spa->spa_dsl_pool, objset_id, FTAG, &ds);
    if (err != 0) {
        result = make_error(err, "dsl_dataset_hold_obj failed: %s",
            strerror(err));
        goto out;
    }

    err = dmu_objset_from_ds(ds, &os);
    if (err != 0) {
        result = make_error(err, "dmu_objset_from_ds failed: %s",
            strerror(err));
        goto out;
    }

    if (dmu_objset_type(os) != DMU_OST_ZFS) {
        result = make_error(EINVAL, "objset is not ZFS (type %d)",
            dmu_objset_type(os));
        goto out;
    }

    sa_handle_t *hdl = NULL;
    err = sa_handle_get(os, objid, NULL, SA_HDL_PRIVATE, &hdl);
    if (err != 0) {
        result = make_error(err, "sa_handle_get failed: %s", strerror(err));
        goto out;
    }

    uint64_t uid = 0, gid = 0, mode = 0, size = 0, links = 0;
    uint64_t parent = 0, gen = 0, flags = 0;
    uint64_t atime[2] = {0, 0};
    uint64_t mtime[2] = {0, 0};
    uint64_t ctime[2] = {0, 0};
    uint64_t crtime[2] = {0, 0};

    sa_bulk_attr_t bulk[12];
    int idx = 0;
    SA_ADD_BULK_ATTR(bulk, idx, sa_attr_table[ZPL_UID], NULL, &uid, 8);
    SA_ADD_BULK_ATTR(bulk, idx, sa_attr_table[ZPL_GID], NULL, &gid, 8);
    SA_ADD_BULK_ATTR(bulk, idx, sa_attr_table[ZPL_LINKS], NULL, &links, 8);
    SA_ADD_BULK_ATTR(bulk, idx, sa_attr_table[ZPL_GEN], NULL, &gen, 8);
    SA_ADD_BULK_ATTR(bulk, idx, sa_attr_table[ZPL_MODE], NULL, &mode, 8);
    SA_ADD_BULK_ATTR(bulk, idx, sa_attr_table[ZPL_PARENT], NULL, &parent, 8);
    SA_ADD_BULK_ATTR(bulk, idx, sa_attr_table[ZPL_SIZE], NULL, &size, 8);
    SA_ADD_BULK_ATTR(bulk, idx, sa_attr_table[ZPL_ATIME], NULL, atime, 16);
    SA_ADD_BULK_ATTR(bulk, idx, sa_attr_table[ZPL_MTIME], NULL, mtime, 16);
    SA_ADD_BULK_ATTR(bulk, idx, sa_attr_table[ZPL_CRTIME], NULL, crtime, 16);
    SA_ADD_BULK_ATTR(bulk, idx, sa_attr_table[ZPL_CTIME], NULL, ctime, 16);
    SA_ADD_BULK_ATTR(bulk, idx, sa_attr_table[ZPL_FLAGS], NULL, &flags, 8);

    boolean_t partial = B_FALSE;
    if (sa_bulk_lookup(hdl, bulk, idx) != 0) {
        partial = B_TRUE;
        (void) sa_lookup(hdl, sa_attr_table[ZPL_UID], &uid, sizeof (uid));
        (void) sa_lookup(hdl, sa_attr_table[ZPL_GID], &gid, sizeof (gid));
        (void) sa_lookup(hdl, sa_attr_table[ZPL_LINKS], &links, sizeof (links));
        (void) sa_lookup(hdl, sa_attr_table[ZPL_GEN], &gen, sizeof (gen));
        (void) sa_lookup(hdl, sa_attr_table[ZPL_MODE], &mode, sizeof (mode));
        (void) sa_lookup(hdl, sa_attr_table[ZPL_PARENT], &parent,
            sizeof (parent));
        (void) sa_lookup(hdl, sa_attr_table[ZPL_SIZE], &size, sizeof (size));
        (void) sa_lookup(hdl, sa_attr_table[ZPL_ATIME], atime, sizeof (atime));
        (void) sa_lookup(hdl, sa_attr_table[ZPL_MTIME], mtime, sizeof (mtime));
        (void) sa_lookup(hdl, sa_attr_table[ZPL_CRTIME], crtime,
            sizeof (crtime));
        (void) sa_lookup(hdl, sa_attr_table[ZPL_CTIME], ctime, sizeof (ctime));
        (void) sa_lookup(hdl, sa_attr_table[ZPL_FLAGS], &flags,
            sizeof (flags));
    }

    sa_handle_destroy(hdl);

    uint64_t dtype = mode_to_dirent_type(mode);
    const char *dtype_name = dirent_type_name(dtype);

    char *result_json = json_format(
        "{"
        "\"objset_id\":%llu,"
        "\"objid\":%llu,"
        "\"mode\":%llu,"
        "\"type\":%llu,"
        "\"type_name\":\"%s\","
        "\"uid\":%llu,"
        "\"gid\":%llu,"
        "\"size\":%llu,"
        "\"links\":%llu,"
        "\"parent\":%llu,"
        "\"flags\":%llu,"
        "\"gen\":%llu,"
        "\"partial\":%s,"
        "\"atime\":{\"sec\":%llu,\"nsec\":%llu},"
        "\"mtime\":{\"sec\":%llu,\"nsec\":%llu},"
        "\"ctime\":{\"sec\":%llu,\"nsec\":%llu},"
        "\"crtime\":{\"sec\":%llu,\"nsec\":%llu}"
        "}",
        (unsigned long long)objset_id,
        (unsigned long long)objid,
        (unsigned long long)mode,
        (unsigned long long)dtype,
        dtype_name,
        (unsigned long long)uid,
        (unsigned long long)gid,
        (unsigned long long)size,
        (unsigned long long)links,
        (unsigned long long)parent,
        (unsigned long long)flags,
        (unsigned long long)gen,
        partial ? "true" : "false",
        (unsigned long long)atime[0],
        (unsigned long long)atime[1],
        (unsigned long long)mtime[0],
        (unsigned long long)mtime[1],
        (unsigned long long)ctime[0],
        (unsigned long long)ctime[1],
        (unsigned long long)crtime[0],
        (unsigned long long)crtime[1]);

    if (!result_json) {
        result = make_error(ENOMEM, "failed to allocate JSON result");
        goto out;
    }

    result = make_success(result_json);

out:
    if (ds)
        dsl_dataset_rele(ds, FTAG);
    if (config_entered)
        dsl_pool_config_exit(spa->spa_dsl_pool, FTAG);
    return result;
}

/*
 * List DMU object types
 */
zdx_result_t
zdx_list_dmu_types(void)
{
    char *array = json_array_start();
    if (!array)
        return make_error(ENOMEM, "failed to allocate JSON array");

    int count = 0;
    for (int i = 0; i < DMU_OT_NUMTYPES; i++) {
        const char *name = dmu_ot[i].ot_name ? dmu_ot[i].ot_name : "unknown";
        char *name_json = json_string(name);
        if (!name_json) {
            free(array);
            return make_error(ENOMEM, "failed to allocate JSON string");
        }

        char *item = json_format(
            "{\"id\":%d,\"name\":%s,\"metadata\":%s,\"encrypted\":%s}",
            i,
            name_json,
            dmu_ot[i].ot_metadata ? "true" : "false",
            dmu_ot[i].ot_encrypt ? "true" : "false");
        free(name_json);

        if (!item) {
            free(array);
            return make_error(ENOMEM, "failed to allocate JSON item");
        }

        char *new_array = json_array_append(array, item);
        free(item);
        if (!new_array) {
            free(array);
            return make_error(ENOMEM, "failed to append JSON item");
        }

        free(array);
        array = new_array;
        count++;
    }

    char *final_json = json_array_end(array, count > 0);
    free(array);
    if (!final_json)
        return make_error(ENOMEM, "failed to finalize JSON");

    return make_success(final_json);
}

/*
 * Callback for zpool_iter - collects pool names into JSON array
 */
typedef struct pool_list_ctx {
    char *json;
    int count;
} pool_list_ctx_t;

static int
list_pools_cb(zpool_handle_t *zhp, void *data)
{
    pool_list_ctx_t *ctx = (pool_list_ctx_t *)data;
    const char *name = zpool_get_name(zhp);

    /* Add pool name to JSON array */
    char *name_json = json_string(name);
    if (!name_json) {
        zpool_close(zhp);
        return -1;
    }

    char *new_json = json_array_append(ctx->json, name_json);
    free(name_json);

    if (!new_json) {
        zpool_close(zhp);
        return -1;
    }

    free(ctx->json);
    ctx->json = new_json;
    ctx->count++;

    zpool_close(zhp);
    return 0;
}

/*
 * List all imported pools
 */
zdx_result_t
zdx_list_pools(void)
{
    if (!g_zfs) {
        return make_error(EINVAL, "libzfs not initialized");
    }

    pool_list_ctx_t ctx = {0};
    ctx.json = json_array_start();
    ctx.count = 0;

    if (!ctx.json) {
        return make_error(ENOMEM, "failed to allocate JSON array");
    }

    /* Iterate all pools */
    int err = zpool_iter(g_zfs, list_pools_cb, &ctx);
    if (err != 0) {
        free(ctx.json);
        return make_error(err, "failed to iterate pools");
    }

    /* Close the JSON array */
    char *final_json = json_array_end(ctx.json, ctx.count > 0);
    free(ctx.json);

    if (!final_json) {
        return make_error(ENOMEM, "failed to finalize JSON");
    }

    return make_success(final_json);
}

/*
 * Return version info
 */
const char *
zdx_version(void)
{
    return ZDX_GIT_SHA;
}

/*
 * Stub implementations for M2 functions
 */

zdx_result_t
zdx_zap_info(zdx_pool_t *pool, uint64_t objid)
{
    if (!pool || !pool->spa)
        return make_error(EINVAL, "pool not open");

    objset_t *mos = spa_meta_objset(pool->spa);
    if (!mos)
        return make_error(EINVAL, "failed to access MOS");

    zap_stats_t zs;
    int err = zap_get_stats(mos, objid, &zs);
    if (err != 0)
        return make_error(err, "zap_get_stats failed: %s", strerror(err));

    int is_micro = (zs.zs_ptrtbl_len == 0);
    char *result = json_format(
        "{"
        "\"object\":%llu,"
        "\"kind\":\"%s\","
        "\"block_size\":%llu,"
        "\"num_entries\":%llu,"
        "\"num_blocks\":%llu,"
        "\"num_leafs\":%llu,"
        "\"ptrtbl_len\":%llu,"
        "\"ptrtbl_zt_blk\":%llu,"
        "\"ptrtbl_zt_numblks\":%llu,"
        "\"ptrtbl_zt_shift\":%llu,"
        "\"ptrtbl_blks_copied\":%llu,"
        "\"ptrtbl_nextblk\":%llu,"
        "\"zap_block_type\":%llu,"
        "\"zap_magic\":%llu,"
        "\"zap_salt\":%llu"
        "}",
        (unsigned long long)objid,
        is_micro ? "microzap" : "fatzap",
        (unsigned long long)zs.zs_blocksize,
        (unsigned long long)zs.zs_num_entries,
        (unsigned long long)zs.zs_num_blocks,
        (unsigned long long)zs.zs_num_leafs,
        (unsigned long long)zs.zs_ptrtbl_len,
        (unsigned long long)zs.zs_ptrtbl_zt_blk,
        (unsigned long long)zs.zs_ptrtbl_zt_numblks,
        (unsigned long long)zs.zs_ptrtbl_zt_shift,
        (unsigned long long)zs.zs_ptrtbl_blks_copied,
        (unsigned long long)zs.zs_ptrtbl_nextblk,
        (unsigned long long)zs.zs_block_type,
        (unsigned long long)zs.zs_magic,
        (unsigned long long)zs.zs_salt);

    if (!result)
        return make_error(ENOMEM, "failed to allocate JSON result");

    return make_success(result);
}

zdx_result_t
zdx_zap_entries(zdx_pool_t *pool, uint64_t objid,
               uint64_t cursor, uint64_t limit)
{
    if (!pool || !pool->spa)
        return make_error(EINVAL, "pool not open");

    objset_t *mos = spa_meta_objset(pool->spa);
    if (!mos)
        return make_error(EINVAL, "failed to access MOS");

    zap_cursor_t zc;
    zap_cursor_init_serialized(&zc, mos, objid, cursor);

    zap_attribute_t *attrp = zap_attribute_long_alloc();
    if (!attrp) {
        zap_cursor_fini(&zc);
        return make_error(ENOMEM, "failed to allocate zap attribute");
    }

    char *array = json_array_start();
    if (!array) {
        zap_attribute_free(attrp);
        zap_cursor_fini(&zc);
        return make_error(ENOMEM, "failed to allocate JSON array");
    }

    uint64_t count = 0;
    int err = 0;
    int done = 0;
    const size_t max_value_bytes = 1024 * 1024;

    while (count < limit) {
        err = zap_cursor_retrieve(&zc, attrp);
        if (err == ENOENT) {
            done = 1;
            break;
        }
        if (err != 0) {
            free(array);
            zap_attribute_free(attrp);
            zap_cursor_fini(&zc);
            return make_error(err, "zap_cursor_retrieve failed: %s",
                strerror(err));
        }

        boolean_t key64 =
            !!(zap_getflags(zc.zc_zap) & ZAP_FLAG_UINT64_KEY);

        uint64_t key_u64 = 0;
        char *name_json = NULL;
        if (key64) {
            memcpy(&key_u64, attrp->za_name, sizeof (uint64_t));
            char *key_str = json_format("0x%016llx",
                (unsigned long long)key_u64);
            if (!key_str) {
                free(array);
                zap_attribute_free(attrp);
                zap_cursor_fini(&zc);
                return make_error(ENOMEM, "failed to allocate key string");
            }
            name_json = json_string(key_str);
            free(key_str);
        } else {
            name_json = json_string(attrp->za_name);
        }

        if (!name_json) {
            free(array);
            zap_attribute_free(attrp);
            zap_cursor_fini(&zc);
            return make_error(ENOMEM, "failed to allocate name string");
        }

        uint64_t value_u64 = 0;
        int maybe_ref = 0;
        uint64_t target_obj = 0;
        char *value_preview = NULL;
        int truncated = 0;

        if (attrp->za_num_integers > 0) {
            size_t size = (size_t)attrp->za_num_integers *
                (size_t)attrp->za_integer_length;
            if (size > max_value_bytes) {
                truncated = 1;
                value_preview = strdup("(truncated)");
            } else {
                void *prop = calloc(1, size);
                if (!prop) {
                    free(name_json);
                    free(array);
                    zap_attribute_free(attrp);
                    zap_cursor_fini(&zc);
                    return make_error(ENOMEM, "failed to allocate zap value");
                }

                int lookup_err;
                if (key64) {
                    lookup_err = zap_lookup_uint64(mos, objid,
                        (const uint64_t *)attrp->za_name, 1,
                        attrp->za_integer_length,
                        attrp->za_num_integers, prop);
                } else {
                    lookup_err = zap_lookup(mos, objid, attrp->za_name,
                        attrp->za_integer_length,
                        attrp->za_num_integers, prop);
                }

                if (lookup_err != 0) {
                    free(prop);
                    free(name_json);
                    free(array);
                    zap_attribute_free(attrp);
                    zap_cursor_fini(&zc);
                    return make_error(lookup_err, "zap_lookup failed: %s",
                        strerror(lookup_err));
                }

                if (attrp->za_integer_length == 8 &&
                    attrp->za_num_integers == 1) {
                    value_u64 = ((uint64_t *)prop)[0];
                    if (value_u64 != 0) {
                        dmu_object_info_t tmp;
                        if (dmu_object_info(mos, value_u64, &tmp) == 0) {
                            maybe_ref = 1;
                            target_obj = value_u64;
                        }
                    }
                }

                if (attrp->za_integer_length == 1) {
                    uint8_t *u8 = (uint8_t *)prop;
                    int printable = 1;
                    for (uint64_t i = 0; i < attrp->za_num_integers; i++) {
                        if (u8[i] == 0) {
                            if (i + 1 != attrp->za_num_integers) {
                                printable = 0;
                                break;
                            }
                            continue;
                        }
                        if (!isprint(u8[i]) && !isspace(u8[i])) {
                            printable = 0;
                            break;
                        }
                    }

                    if (printable) {
                        size_t slen = attrp->za_num_integers;
                        if (slen > 0 && u8[slen - 1] == 0)
                            slen--;
                        char *tmp = malloc(slen + 1);
                        if (tmp) {
                            memcpy(tmp, u8, slen);
                            tmp[slen] = '\0';
                            value_preview = tmp;
                        }
                    }

                    if (!value_preview) {
                        value_preview = bytes_to_hex(u8,
                            (size_t)attrp->za_num_integers);
                    }
                } else {
                    value_preview = numbers_preview(prop,
                        attrp->za_num_integers, attrp->za_integer_length);
                }

                free(prop);
            }
        } else {
            value_preview = strdup("");
        }

        if (!value_preview)
            value_preview = strdup("");

        char *value_json = json_string(value_preview);
        if (!value_json) {
            free(value_preview);
            free(name_json);
            free(array);
            zap_attribute_free(attrp);
            zap_cursor_fini(&zc);
            return make_error(ENOMEM, "failed to allocate value string");
        }

        char key_buf[32];
        char value_buf[32];
        const char *key_json = "null";
        const char *value_u64_json = "null";
        const char *ref_json = "null";
        const char *target_json = "null";

        if (key64) {
            (void)snprintf(key_buf, sizeof (key_buf), "%llu",
                (unsigned long long)key_u64);
            key_json = key_buf;
        }

        if (attrp->za_integer_length == 8 && attrp->za_num_integers == 1) {
            (void)snprintf(value_buf, sizeof (value_buf), "%llu",
                (unsigned long long)value_u64);
            value_u64_json = value_buf;
            ref_json = value_buf;
        }
        if (maybe_ref) {
            (void)snprintf(value_buf, sizeof (value_buf), "%llu",
                (unsigned long long)target_obj);
            target_json = value_buf;
        }

        char *item = json_format(
            "{"
            "\"name\":%s,"
            "\"key_u64\":%s,"
            "\"integer_length\":%d,"
            "\"num_integers\":%llu,"
            "\"value_preview\":%s,"
            "\"value_u64\":%s,"
            "\"ref_objid\":%s,"
            "\"maybe_object_ref\":%s,"
            "\"target_obj\":%s,"
            "\"truncated\":%s"
            "}",
            name_json,
            key_json,
            attrp->za_integer_length,
            (unsigned long long)attrp->za_num_integers,
            value_json,
            value_u64_json,
            ref_json,
            maybe_ref ? "true" : "false",
            target_json,
            truncated ? "true" : "false");

        free(value_preview);
        free(value_json);
        free(name_json);

        if (!item) {
            free(array);
            zap_attribute_free(attrp);
            zap_cursor_fini(&zc);
            return make_error(ENOMEM, "failed to allocate JSON item");
        }

        char *new_array = json_array_append(array, item);
        free(item);
        if (!new_array) {
            free(array);
            zap_attribute_free(attrp);
            zap_cursor_fini(&zc);
            return make_error(ENOMEM, "failed to append JSON item");
        }

        free(array);
        array = new_array;
        count++;

        zap_cursor_advance(&zc);
    }

    char *entries_json = json_array_end(array, count > 0);
    free(array);
    if (!entries_json) {
        zap_attribute_free(attrp);
        zap_cursor_fini(&zc);
        return make_error(ENOMEM, "failed to finalize JSON array");
    }

    uint64_t next = 0;
    if (!done)
        next = zap_cursor_serialize(&zc);

    char next_buf[32];
    const char *next_json = "null";
    if (!done) {
        (void)snprintf(next_buf, sizeof (next_buf), "%llu",
            (unsigned long long)next);
        next_json = next_buf;
    }

    char *result = json_format(
        "{"
        "\"object\":%llu,"
        "\"cursor\":%llu,"
        "\"next\":%s,"
        "\"count\":%llu,"
        "\"entries\":%s"
        "}",
        (unsigned long long)objid,
        (unsigned long long)cursor,
        next_json,
        (unsigned long long)count,
        entries_json);

    free(entries_json);
    zap_attribute_free(attrp);
    zap_cursor_fini(&zc);

    if (!result)
        return make_error(ENOMEM, "failed to allocate JSON result");

    return make_success(result);
}

/*
 * Read a raw block by vdev + offset.
 */
zdx_result_t
zdx_read_block(zdx_pool_t *pool, uint64_t vdev_id,
    uint64_t offset, uint64_t size)
{
    if (!pool || !pool->spa)
        return make_error(EINVAL, "pool not open");

    if (size == 0)
        return make_error(EINVAL, "size must be > 0");

    const uint64_t max_read = 1ULL << 20; /* 1 MiB safety cap */
    if (size > max_read)
        return make_error(EINVAL, "size too large (max %llu bytes)",
            (unsigned long long)max_read);

    spa_t *spa = pool->spa;
    spa_config_enter(spa, SCL_VDEV, FTAG, RW_READER);
    vdev_t *vd = vdev_lookup_top(spa, vdev_id);
    spa_config_exit(spa, SCL_VDEV, FTAG);

    if (!vd)
        return make_error(ENOENT, "vdev %llu not found",
            (unsigned long long)vdev_id);

    if (!vdev_readable(vd))
        return make_error(EIO, "vdev %llu not readable",
            (unsigned long long)vdev_id);

    abd_t *abd = abd_alloc(size, B_FALSE);
    if (!abd)
        return make_error(ENOMEM, "failed to allocate abd");

    blkptr_t bp;
    dva_t *dva = &bp.blk_dva[0];
    BP_ZERO(&bp);

    DVA_SET_VDEV(&dva[0], vdev_id);
    DVA_SET_OFFSET(&dva[0], offset);
    DVA_SET_GANG(&dva[0], 0);
    DVA_SET_ASIZE(&dva[0], size);

    BP_SET_BIRTH(&bp, TXG_INITIAL, TXG_INITIAL);
    BP_SET_LSIZE(&bp, size);
    BP_SET_PSIZE(&bp, size);
    BP_SET_COMPRESS(&bp, ZIO_COMPRESS_OFF);
    BP_SET_CHECKSUM(&bp, ZIO_CHECKSUM_OFF);
    BP_SET_TYPE(&bp, DMU_OT_NONE);
    BP_SET_LEVEL(&bp, 0);
    BP_SET_DEDUP(&bp, 0);
    BP_SET_BYTEORDER(&bp, ZFS_HOST_BYTEORDER);

    spa_config_enter(spa, SCL_STATE, FTAG, RW_READER);
    zio_t *zio = zio_root(spa, NULL, NULL, ZIO_FLAG_CANFAIL);
    if (!zio) {
        spa_config_exit(spa, SCL_STATE, FTAG);
        abd_free(abd);
        return make_error(ENOMEM, "failed to create zio root");
    }

    zio_nowait(zio_read(zio, spa, &bp, abd, size,
        NULL, NULL, ZIO_PRIORITY_SYNC_READ,
        ZIO_FLAG_CANFAIL | ZIO_FLAG_RAW, NULL));

    int err = zio_wait(zio);
    spa_config_exit(spa, SCL_STATE, FTAG);
    if (err != 0) {
        abd_free(abd);
        return make_error(err, "zio_read failed: %s", strerror(err));
    }

    void *buf = abd_borrow_buf_copy(abd, size);
    if (!buf) {
        abd_free(abd);
        return make_error(ENOMEM, "failed to borrow abd buffer");
    }

    char *hex = bytes_to_hex((const uint8_t *)buf, (size_t)size);
    abd_return_buf_copy(abd, buf, size);
    abd_free(abd);
    if (!hex)
        return make_error(ENOMEM, "failed to encode hex");

    char *hex_json = json_string(hex);
    free(hex);
    if (!hex_json)
        return make_error(ENOMEM, "failed to allocate JSON string");

    char *result = json_format(
        "{"
        "\"vdev\":%llu,"
        "\"offset\":%llu,"
        "\"size\":%llu,"
        "\"data_hex\":%s"
        "}",
        (unsigned long long)vdev_id,
        (unsigned long long)offset,
        (unsigned long long)size,
        hex_json);
    free(hex_json);

    if (!result)
        return make_error(ENOMEM, "failed to allocate JSON result");

    return make_success(result);
}
