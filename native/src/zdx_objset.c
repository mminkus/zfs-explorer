#include "zdbdecode_internal.h"

/*
 * Master node contains a mix of object references and scalar config values.
 * Do not treat every uint64 value as an object pointer.
 */
static boolean_t
master_node_key_is_object_ref(const char *name)
{
    if (name == NULL)
        return (B_FALSE);

    return (strcmp(name, ZFS_ROOT_OBJ) == 0 ||
        strcmp(name, ZFS_UNLINKED_SET) == 0 ||
        strcmp(name, ZFS_SA_ATTRS) == 0 ||
        strcmp(name, ZFS_FUID_TABLES) == 0 ||
        strcmp(name, ZFS_SHARES_DIR) == 0);
}

/*
 * Convert blkptr to JSON object.
 * Kept local to objset inspector paths so we can decode ZPL object blkptrs.
 */
static char *
objset_blkptr_to_json(const blkptr_t *bp, int index, int is_spill)
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
        return (NULL);

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
            return (NULL);
        }

        char *new_dvas = json_array_append(dvas, item);
        free(item);
        if (!new_dvas) {
            free(dvas);
            return (NULL);
        }

        free(dvas);
        dvas = new_dvas;
        dva_count++;
    }

    char *dvas_json = json_array_end(dvas, dva_count > 0);
    free(dvas);
    if (!dvas_json)
        return (NULL);

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
    return (result);
}

/*
 * List objects from a ZFS objset with optional type filter + pagination.
 */
zdx_result_t
zdx_objset_list_objects(zdx_pool_t *pool, uint64_t objset_id, int type_filter,
    uint64_t start, uint64_t limit)
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
        return make_error(err, "objset_list_objects: dmu_objset_from_ds failed: %s",
            strerror(err));
    }

    if (dmu_objset_type(os) != DMU_OST_ZFS) {
        dsl_dataset_rele(ds, FTAG);
        dsl_pool_config_exit(spa->spa_dsl_pool, FTAG);
        return make_error(EINVAL, "objset is not ZFS (type %d)",
            dmu_objset_type(os));
    }

    char *array = json_array_start();
    if (!array) {
        dsl_dataset_rele(ds, FTAG);
        dsl_pool_config_exit(spa->spa_dsl_pool, FTAG);
        return make_error(ENOMEM, "failed to allocate JSON array");
    }

    uint64_t object = start;
    uint64_t last_obj = 0;
    int count = 0;

    while (count < (int)limit) {
        err = dmu_object_next(os, &object, B_FALSE, 0);
        if (err != 0)
            break;
        last_obj = object;

        dmu_object_info_t doi;
        if (dmu_object_info(os, object, &doi) != 0)
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
            dsl_dataset_rele(ds, FTAG);
            dsl_pool_config_exit(spa->spa_dsl_pool, FTAG);
            return make_error(ENOMEM, "failed to allocate JSON strings");
        }

        char *item = json_format(
            "{"
            "\"id\":%llu,"
            "\"type\":%u,"
            "\"type_name\":%s,"
            "\"bonus_type\":%u,"
            "\"bonus_type_name\":%s"
            "}",
            (unsigned long long)object,
            (unsigned)doi.doi_type,
            type_name,
            (unsigned)doi.doi_bonus_type,
            bonus_name);
        free(type_name);
        free(bonus_name);

        if (!item) {
            free(array);
            dsl_dataset_rele(ds, FTAG);
            dsl_pool_config_exit(spa->spa_dsl_pool, FTAG);
            return make_error(ENOMEM, "failed to allocate JSON item");
        }

        char *new_array = json_array_append(array, item);
        free(item);
        if (!new_array) {
            free(array);
            dsl_dataset_rele(ds, FTAG);
            dsl_pool_config_exit(spa->spa_dsl_pool, FTAG);
            return make_error(ENOMEM, "failed to append JSON item");
        }

        free(array);
        array = new_array;
        count++;
    }

    if (err != 0 && err != ENOENT && err != ESRCH && err != EXDEV
#ifdef EBADE
        && err != EBADE
#endif
    ) {
        free(array);
        dsl_dataset_rele(ds, FTAG);
        dsl_pool_config_exit(spa->spa_dsl_pool, FTAG);
        return make_error(err, "dmu_object_next failed: %s", strerror(err));
    }

    char *objects_json = json_array_end(array, count > 0);
    free(array);
    if (!objects_json) {
        dsl_dataset_rele(ds, FTAG);
        dsl_pool_config_exit(spa->spa_dsl_pool, FTAG);
        return make_error(ENOMEM, "failed to finalize JSON array");
    }

    int has_more = 0;
    if (count > 0 && count == (int)limit) {
        uint64_t peek = object;
        if (dmu_object_next(os, &peek, B_FALSE, 0) == 0)
            has_more = 1;
    }

    char *next_json = has_more
        ? json_format("%llu", (unsigned long long)last_obj)
        : strdup("null");
    if (!next_json) {
        free(objects_json);
        dsl_dataset_rele(ds, FTAG);
        dsl_pool_config_exit(spa->spa_dsl_pool, FTAG);
        return make_error(ENOMEM, "failed to allocate next cursor");
    }

    char *result = json_format(
        "{"
        "\"objset_id\":%llu,"
        "\"start\":%llu,"
        "\"limit\":%llu,"
        "\"count\":%d,"
        "\"next\":%s,"
        "\"objects\":%s"
        "}",
        (unsigned long long)objset_id,
        (unsigned long long)start,
        (unsigned long long)limit,
        count,
        next_json,
        objects_json);
    free(next_json);
    free(objects_json);
    dsl_dataset_rele(ds, FTAG);
    dsl_pool_config_exit(spa->spa_dsl_pool, FTAG);

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
        return make_error(err, "objset_root: dmu_objset_from_ds failed: %s",
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
        return make_error(err, "objset_dir_entries: dmu_objset_from_ds failed: %s",
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

    /*
     * Some exported/offline datasets can legitimately have a hole rootbp.
     * Calling dmu_objset_from_ds() on those can trigger fragile error paths
     * in certain userland/libzpool combinations. Short-circuit first.
     */
    const blkptr_t *head_bp = dsl_dataset_get_blkptr(ds);
    if (head_bp == NULL || BP_IS_HOLE(head_bp)) {
        result = make_error(ENOENT,
            "objset_walk: dataset %llu has no objset (hole rootbp)",
            (unsigned long long)objset_id);
        goto out;
    }

    err = dmu_objset_from_ds(ds, &os);
    if (err != 0) {
        result = make_error(err, "objset_walk: dmu_objset_from_ds failed: %s",
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
    sa_attr_type_t *sa_table = NULL;
    boolean_t sa_setup_done = B_FALSE;

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
        result = make_error(err, "objset_stat: dmu_objset_from_ds failed: %s",
            strerror(err));
        goto out;
    }

    if (dmu_objset_type(os) != DMU_OST_ZFS) {
        result = make_error(EINVAL, "objset is not ZFS (type %d)",
            dmu_objset_type(os));
        goto out;
    }

    err = zdx_sa_setup(os, &sa_table);
    if (err != 0) {
        result = make_error(err, "sa_setup failed: %s", strerror(err));
        goto out;
    }
    sa_setup_done = B_TRUE;

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
    SA_ADD_BULK_ATTR(bulk, idx, sa_table[ZPL_UID], NULL, &uid, 8);
    SA_ADD_BULK_ATTR(bulk, idx, sa_table[ZPL_GID], NULL, &gid, 8);
    SA_ADD_BULK_ATTR(bulk, idx, sa_table[ZPL_LINKS], NULL, &links, 8);
    SA_ADD_BULK_ATTR(bulk, idx, sa_table[ZPL_GEN], NULL, &gen, 8);
    SA_ADD_BULK_ATTR(bulk, idx, sa_table[ZPL_MODE], NULL, &mode, 8);
    SA_ADD_BULK_ATTR(bulk, idx, sa_table[ZPL_PARENT], NULL, &parent, 8);
    SA_ADD_BULK_ATTR(bulk, idx, sa_table[ZPL_SIZE], NULL, &size, 8);
    SA_ADD_BULK_ATTR(bulk, idx, sa_table[ZPL_ATIME], NULL, atime, 16);
    SA_ADD_BULK_ATTR(bulk, idx, sa_table[ZPL_MTIME], NULL, mtime, 16);
    SA_ADD_BULK_ATTR(bulk, idx, sa_table[ZPL_CRTIME], NULL, crtime, 16);
    SA_ADD_BULK_ATTR(bulk, idx, sa_table[ZPL_CTIME], NULL, ctime, 16);
    SA_ADD_BULK_ATTR(bulk, idx, sa_table[ZPL_FLAGS], NULL, &flags, 8);

    boolean_t partial = B_FALSE;
    if (sa_bulk_lookup(hdl, bulk, idx) != 0) {
        partial = B_TRUE;
        (void) sa_lookup(hdl, sa_table[ZPL_UID], &uid, sizeof (uid));
        (void) sa_lookup(hdl, sa_table[ZPL_GID], &gid, sizeof (gid));
        (void) sa_lookup(hdl, sa_table[ZPL_LINKS], &links, sizeof (links));
        (void) sa_lookup(hdl, sa_table[ZPL_GEN], &gen, sizeof (gen));
        (void) sa_lookup(hdl, sa_table[ZPL_MODE], &mode, sizeof (mode));
        (void) sa_lookup(hdl, sa_table[ZPL_PARENT], &parent,
            sizeof (parent));
        (void) sa_lookup(hdl, sa_table[ZPL_SIZE], &size, sizeof (size));
        (void) sa_lookup(hdl, sa_table[ZPL_ATIME], atime, sizeof (atime));
        (void) sa_lookup(hdl, sa_table[ZPL_MTIME], mtime, sizeof (mtime));
        (void) sa_lookup(hdl, sa_table[ZPL_CRTIME], crtime,
            sizeof (crtime));
        (void) sa_lookup(hdl, sa_table[ZPL_CTIME], ctime, sizeof (ctime));
        (void) sa_lookup(hdl, sa_table[ZPL_FLAGS], &flags,
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
    if (sa_setup_done && os && os->os_sa != NULL)
        sa_tear_down(os);
    if (ds)
        dsl_dataset_rele(ds, FTAG);
    if (config_entered)
        dsl_pool_config_exit(spa->spa_dsl_pool, FTAG);
    return result;
}

/*
 * Get objset object dnode metadata (same shape as MOS object inspector).
 */
zdx_result_t
zdx_objset_get_object(zdx_pool_t *pool, uint64_t objset_id, uint64_t objid)
{
    if (!pool || !pool->spa)
        return make_error(EINVAL, "pool not open");

    spa_t *spa = pool->spa;
    dsl_dataset_t *ds = NULL;
    objset_t *os = NULL;
    dnode_t *dn = NULL;
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
        return make_error(err, "objset_get_object: dmu_objset_from_ds failed: %s",
            strerror(err));
    }

    if (dmu_objset_type(os) != DMU_OST_ZFS) {
        dsl_dataset_rele(ds, FTAG);
        dsl_pool_config_exit(spa->spa_dsl_pool, FTAG);
        return make_error(EINVAL, "objset is not ZFS (type %d)",
            dmu_objset_type(os));
    }

    err = dnode_hold(os, objid, FTAG, &dn);
    if (err != 0) {
        dsl_dataset_rele(ds, FTAG);
        dsl_pool_config_exit(spa->spa_dsl_pool, FTAG);
        return make_error(err, "dnode_hold failed for object %llu",
            (unsigned long long)objid);
    }

    dmu_object_info_t doi;
    dmu_object_info_from_dnode(dn, &doi);

    dnode_phys_t *dnp = dn->dn_phys;
    if (!dnp) {
        dnode_rele(dn, FTAG);
        dsl_dataset_rele(ds, FTAG);
        dsl_pool_config_exit(spa->spa_dsl_pool, FTAG);
        return make_error(EIO, "missing dnode phys for object %llu",
            (unsigned long long)objid);
    }

    char *type_name = json_string(dmu_ot_name_safe(doi.doi_type));
    char *bonus_name = json_string(dmu_ot_name_safe(doi.doi_bonus_type));
    if (!type_name || !bonus_name) {
        free(type_name);
        free(bonus_name);
        dnode_rele(dn, FTAG);
        dsl_dataset_rele(ds, FTAG);
        dsl_pool_config_exit(spa->spa_dsl_pool, FTAG);
        return make_error(ENOMEM, "failed to allocate JSON strings");
    }

    uint64_t used_bytes = DN_USED_BYTES(dnp);
    uint64_t indirect_block_size = 1ULL << dnp->dn_indblkshift;
    int is_zap = (DMU_OT_BYTESWAP(doi.doi_type) == DMU_BSWAP_ZAP);

    char *result = json_format(
        "{"
        "\"objset_id\":%llu,"
        "\"id\":%llu,"
        "\"type\":{\"id\":%u,\"name\":%s},"
        "\"bonus_type\":{\"id\":%u,\"name\":%s},"
        "\"is_zap\":%s,"
        "\"bonus_decoded\":null,"
        "\"semantic_edges\":[],"
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
        (unsigned long long)objset_id,
        (unsigned long long)objid,
        (unsigned)doi.doi_type,
        type_name,
        (unsigned)doi.doi_bonus_type,
        bonus_name,
        is_zap ? "true" : "false",
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

    free(type_name);
    free(bonus_name);
    dnode_rele(dn, FTAG);
    dsl_dataset_rele(ds, FTAG);
    dsl_pool_config_exit(spa->spa_dsl_pool, FTAG);

    if (!result)
        return make_error(ENOMEM, "failed to allocate JSON result");

    return make_success(result);
}

/*
 * Get objset object block pointers.
 */
zdx_result_t
zdx_objset_get_blkptrs(zdx_pool_t *pool, uint64_t objset_id, uint64_t objid)
{
    if (!pool || !pool->spa)
        return make_error(EINVAL, "pool not open");

    spa_t *spa = pool->spa;
    dsl_dataset_t *ds = NULL;
    objset_t *os = NULL;
    dnode_t *dn = NULL;
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
        return make_error(err, "objset_get_blkptrs: dmu_objset_from_ds failed: %s",
            strerror(err));
    }

    if (dmu_objset_type(os) != DMU_OST_ZFS) {
        dsl_dataset_rele(ds, FTAG);
        dsl_pool_config_exit(spa->spa_dsl_pool, FTAG);
        return make_error(EINVAL, "objset is not ZFS (type %d)",
            dmu_objset_type(os));
    }

    err = dnode_hold(os, objid, FTAG, &dn);
    if (err != 0) {
        dsl_dataset_rele(ds, FTAG);
        dsl_pool_config_exit(spa->spa_dsl_pool, FTAG);
        return make_error(err, "dnode_hold failed for object %llu",
            (unsigned long long)objid);
    }

    dnode_phys_t *dnp = dn->dn_phys;
    if (!dnp) {
        dnode_rele(dn, FTAG);
        dsl_dataset_rele(ds, FTAG);
        dsl_pool_config_exit(spa->spa_dsl_pool, FTAG);
        return make_error(EIO, "missing dnode phys for object %llu",
            (unsigned long long)objid);
    }

    char *array = json_array_start();
    if (!array) {
        dnode_rele(dn, FTAG);
        dsl_dataset_rele(ds, FTAG);
        dsl_pool_config_exit(spa->spa_dsl_pool, FTAG);
        return make_error(ENOMEM, "failed to allocate JSON array");
    }

    int count = 0;
    for (int i = 0; i < dnp->dn_nblkptr; i++) {
        blkptr_t *bp = &dnp->dn_blkptr[i];
        char *item = objset_blkptr_to_json(bp, i, 0);
        if (!item) {
            free(array);
            dnode_rele(dn, FTAG);
            dsl_dataset_rele(ds, FTAG);
            dsl_pool_config_exit(spa->spa_dsl_pool, FTAG);
            return make_error(ENOMEM, "failed to build blkptr JSON");
        }

        char *new_array = json_array_append(array, item);
        free(item);
        if (!new_array) {
            free(array);
            dnode_rele(dn, FTAG);
            dsl_dataset_rele(ds, FTAG);
            dsl_pool_config_exit(spa->spa_dsl_pool, FTAG);
            return make_error(ENOMEM, "failed to append blkptr JSON");
        }

        free(array);
        array = new_array;
        count++;
    }

    int has_spill = (dnp->dn_flags & DNODE_FLAG_SPILL_BLKPTR) != 0;
    if (has_spill) {
        blkptr_t *spill = DN_SPILL_BLKPTR(dnp);
        char *item = objset_blkptr_to_json(spill, dnp->dn_nblkptr, 1);
        if (!item) {
            free(array);
            dnode_rele(dn, FTAG);
            dsl_dataset_rele(ds, FTAG);
            dsl_pool_config_exit(spa->spa_dsl_pool, FTAG);
            return make_error(ENOMEM, "failed to build spill blkptr JSON");
        }

        char *new_array = json_array_append(array, item);
        free(item);
        if (!new_array) {
            free(array);
            dnode_rele(dn, FTAG);
            dsl_dataset_rele(ds, FTAG);
            dsl_pool_config_exit(spa->spa_dsl_pool, FTAG);
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
        dsl_dataset_rele(ds, FTAG);
        dsl_pool_config_exit(spa->spa_dsl_pool, FTAG);
        return make_error(ENOMEM, "failed to finalize blkptrs JSON");
    }

    char *result = json_format(
        "{"
        "\"objset_id\":%llu,"
        "\"id\":%llu,"
        "\"nblkptr\":%u,"
        "\"has_spill\":%s,"
        "\"blkptrs\":%s"
        "}",
        (unsigned long long)objset_id,
        (unsigned long long)objid,
        (unsigned)dnp->dn_nblkptr,
        has_spill ? "true" : "false",
        blkptrs_json);
    free(blkptrs_json);
    dnode_rele(dn, FTAG);
    dsl_dataset_rele(ds, FTAG);
    dsl_pool_config_exit(spa->spa_dsl_pool, FTAG);

    if (!result)
        return make_error(ENOMEM, "failed to allocate JSON result");

    return make_success(result);
}

/*
 * Get ZAP metadata for an object inside a ZPL objset.
 */
zdx_result_t
zdx_objset_zap_info(zdx_pool_t *pool, uint64_t objset_id, uint64_t objid)
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
        return make_error(err, "objset_zap_info: dmu_objset_from_ds failed: %s",
            strerror(err));
    }

    if (dmu_objset_type(os) != DMU_OST_ZFS) {
        dsl_dataset_rele(ds, FTAG);
        dsl_pool_config_exit(spa->spa_dsl_pool, FTAG);
        return make_error(EINVAL, "objset is not ZFS (type %d)",
            dmu_objset_type(os));
    }

    zap_stats_t zs;
    err = zap_get_stats(os, objid, &zs);
    if (err != 0) {
        dsl_dataset_rele(ds, FTAG);
        dsl_pool_config_exit(spa->spa_dsl_pool, FTAG);
        return make_error(err, "zap_get_stats failed: %s", strerror(err));
    }

    int is_micro = (zs.zs_ptrtbl_len == 0);
    char *result = json_format(
        "{"
        "\"objset_id\":%llu,"
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
        (unsigned long long)objset_id,
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

    dsl_dataset_rele(ds, FTAG);
    dsl_pool_config_exit(spa->spa_dsl_pool, FTAG);

    if (!result)
        return make_error(ENOMEM, "failed to allocate JSON result");

    return make_success(result);
}

/*
 * Get paginated ZAP entries for an object inside a ZPL objset.
 */
zdx_result_t
zdx_objset_zap_entries(zdx_pool_t *pool, uint64_t objset_id, uint64_t objid,
    uint64_t cursor, uint64_t limit)
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
        return make_error(err, "objset_zap_entries: dmu_objset_from_ds failed: %s",
            strerror(err));
    }

    if (dmu_objset_type(os) != DMU_OST_ZFS) {
        dsl_dataset_rele(ds, FTAG);
        dsl_pool_config_exit(spa->spa_dsl_pool, FTAG);
        return make_error(EINVAL, "objset is not ZFS (type %d)",
            dmu_objset_type(os));
    }

    /*
     * ZFS directory ZAP values are packed dirents:
     * upper bits carry entry type, low 48 bits carry object id.
     */
    boolean_t decode_dirent_values = B_FALSE;
    dmu_object_info_t zap_doi;
    if (dmu_object_info(os, objid, &zap_doi) == 0 &&
        zap_doi.doi_type == DMU_OT_DIRECTORY_CONTENTS) {
        decode_dirent_values = B_TRUE;
    }

    zap_cursor_t zc;
    zap_cursor_init_serialized(&zc, os, objid, cursor);

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
            dsl_dataset_rele(ds, FTAG);
            dsl_pool_config_exit(spa->spa_dsl_pool, FTAG);
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
                dsl_dataset_rele(ds, FTAG);
                dsl_pool_config_exit(spa->spa_dsl_pool, FTAG);
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
            dsl_dataset_rele(ds, FTAG);
            dsl_pool_config_exit(spa->spa_dsl_pool, FTAG);
            return make_error(ENOMEM, "failed to allocate name string");
        }

        uint64_t value_u64 = 0;
        uint64_t value_u64_raw = 0;
        uint64_t dirent_obj = 0;
        uint64_t dirent_type = 0;
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
                    dsl_dataset_rele(ds, FTAG);
                    dsl_pool_config_exit(spa->spa_dsl_pool, FTAG);
                    return make_error(ENOMEM,
                        "failed to allocate zap value");
                }

                int lookup_err;
                if (key64) {
                    lookup_err = zap_lookup_uint64(os, objid,
                        (const uint64_t *)attrp->za_name, 1,
                        attrp->za_integer_length,
                        attrp->za_num_integers, prop);
                } else {
                    lookup_err = zap_lookup(os, objid, attrp->za_name,
                        attrp->za_integer_length,
                        attrp->za_num_integers, prop);
                }

                if (lookup_err != 0) {
                    free(prop);
                    free(name_json);
                    free(array);
                    zap_attribute_free(attrp);
                    zap_cursor_fini(&zc);
                    dsl_dataset_rele(ds, FTAG);
                    dsl_pool_config_exit(spa->spa_dsl_pool, FTAG);
                    return make_error(lookup_err, "zap_lookup failed: %s",
                        strerror(lookup_err));
                }

                if (attrp->za_integer_length == 8 &&
                    attrp->za_num_integers == 1) {
                    value_u64_raw = ((uint64_t *)prop)[0];
                    value_u64 = value_u64_raw;
                    if (decode_dirent_values && !key64) {
                        dirent_obj = ZFS_DIRENT_OBJ(value_u64_raw);
                        dirent_type = ZFS_DIRENT_TYPE(value_u64_raw);
                        value_u64 = dirent_obj;
                    }
                    boolean_t allow_object_ref = B_TRUE;
                    if (objid == MASTER_NODE_OBJ && !key64) {
                        allow_object_ref =
                            master_node_key_is_object_ref(attrp->za_name);
                    }
                    if (allow_object_ref && value_u64 != 0) {
                        dmu_object_info_t tmp;
                        if (dmu_object_info(os, value_u64, &tmp) == 0) {
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
                } else if (decode_dirent_values && !key64 &&
                    attrp->za_integer_length == 8 &&
                    attrp->za_num_integers == 1) {
                    value_preview = json_format("%llu (type: %s)",
                        (unsigned long long)value_u64,
                        dirent_type_name(dirent_type));
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
            dsl_dataset_rele(ds, FTAG);
            dsl_pool_config_exit(spa->spa_dsl_pool, FTAG);
            return make_error(ENOMEM, "failed to allocate value string");
        }

        char key_buf[32];
        char value_u64_buf[32];
        char raw_value_u64_buf[32];
        char ref_buf[32];
        char dirent_obj_buf[32];
        char dirent_type_buf[32];
        const char *key_json = "null";
        const char *value_u64_json = "null";
        const char *raw_value_u64_json = "null";
        const char *ref_json = "null";
        const char *target_json = "null";
        const char *dirent_obj_json = "null";
        const char *dirent_type_json = "null";
        char *dirent_type_name_json = NULL;

        if (key64) {
            (void)snprintf(key_buf, sizeof (key_buf), "%llu",
                (unsigned long long)key_u64);
            key_json = key_buf;
        }

        if (attrp->za_integer_length == 8 && attrp->za_num_integers == 1) {
            (void)snprintf(value_u64_buf, sizeof (value_u64_buf), "%llu",
                (unsigned long long)value_u64);
            value_u64_json = value_u64_buf;
        }
        if (decode_dirent_values && !key64 &&
            attrp->za_integer_length == 8 && attrp->za_num_integers == 1) {
            (void)snprintf(raw_value_u64_buf, sizeof (raw_value_u64_buf), "%llu",
                (unsigned long long)value_u64_raw);
            raw_value_u64_json = raw_value_u64_buf;
            (void)snprintf(dirent_obj_buf, sizeof (dirent_obj_buf), "%llu",
                (unsigned long long)dirent_obj);
            (void)snprintf(dirent_type_buf, sizeof (dirent_type_buf), "%llu",
                (unsigned long long)dirent_type);
            dirent_obj_json = dirent_obj_buf;
            dirent_type_json = dirent_type_buf;
            dirent_type_name_json = json_string(dirent_type_name(dirent_type));
        }
        if (!dirent_type_name_json)
            dirent_type_name_json = strdup("null");
        if (maybe_ref) {
            (void)snprintf(ref_buf, sizeof (ref_buf), "%llu",
                (unsigned long long)target_obj);
            ref_json = ref_buf;
            target_json = ref_buf;
        }

        char *item = json_format(
            "{"
            "\"name\":%s,"
            "\"key_u64\":%s,"
            "\"integer_length\":%d,"
            "\"num_integers\":%llu,"
            "\"value_preview\":%s,"
            "\"value_u64\":%s,"
            "\"raw_value_u64\":%s,"
            "\"dirent_obj\":%s,"
            "\"dirent_type\":%s,"
            "\"dirent_type_name\":%s,"
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
            raw_value_u64_json,
            dirent_obj_json,
            dirent_type_json,
            dirent_type_name_json,
            ref_json,
            maybe_ref ? "true" : "false",
            target_json,
            truncated ? "true" : "false");

        free(value_preview);
        free(value_json);
        free(dirent_type_name_json);
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
        "\"object\":%llu,"
        "\"cursor\":%llu,"
        "\"next\":%s,"
        "\"count\":%llu,"
        "\"entries\":%s"
        "}",
        (unsigned long long)objset_id,
        (unsigned long long)objid,
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
 * Read logical object data from a ZFS objset object.
 * This uses dmu_read() (logical view), not raw DVA reads.
 */
zdx_result_t
zdx_objset_read_data(zdx_pool_t *pool, uint64_t objset_id, uint64_t objid,
    uint64_t offset, uint64_t limit)
{
    if (!pool || !pool->spa)
        return make_error(EINVAL, "pool not open");
    if (limit == 0)
        return make_error(EINVAL, "limit must be > 0");

    const uint64_t max_read = 1ULL << 20; /* 1 MiB hard cap per request */
    uint64_t request_limit = limit;
    if (request_limit > max_read)
        request_limit = max_read;

    spa_t *spa = pool->spa;
    dsl_dataset_t *ds = NULL;
    objset_t *os = NULL;
    dmu_object_info_t doi;
    int err;
    char *hex = NULL;
    char *hex_json = NULL;
    char *result_json = NULL;
    void *buf = NULL;
    uint64_t max_offset = 0;
    uint64_t read_size = 0;
    boolean_t eof = B_TRUE;

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
        return make_error(err, "objset_read_data: dmu_objset_from_ds failed: %s",
            strerror(err));
    }

    if (dmu_objset_type(os) != DMU_OST_ZFS) {
        dsl_dataset_rele(ds, FTAG);
        dsl_pool_config_exit(spa->spa_dsl_pool, FTAG);
        return make_error(EINVAL, "objset is not ZFS (type %d)",
            dmu_objset_type(os));
    }

    err = dmu_object_info(os, objid, &doi);
    if (err != 0) {
        dsl_dataset_rele(ds, FTAG);
        dsl_pool_config_exit(spa->spa_dsl_pool, FTAG);
        return make_error(err, "dmu_object_info failed for object %llu: %s",
            (unsigned long long)objid, strerror(err));
    }

    max_offset = doi.doi_max_offset;
    if (offset < max_offset) {
        read_size = max_offset - offset;
        if (read_size > request_limit)
            read_size = request_limit;
    } else {
        read_size = 0;
    }

    if (read_size > 0) {
        buf = malloc((size_t)read_size);
        if (!buf) {
            dsl_dataset_rele(ds, FTAG);
            dsl_pool_config_exit(spa->spa_dsl_pool, FTAG);
            return make_error(ENOMEM, "failed to allocate read buffer");
        }

        err = dmu_read(os, objid, offset, read_size, buf, 0);
        if (err != 0) {
            free(buf);
            dsl_dataset_rele(ds, FTAG);
            dsl_pool_config_exit(spa->spa_dsl_pool, FTAG);
            return make_error(err, "dmu_read failed for object %llu: %s",
                (unsigned long long)objid, strerror(err));
        }

        hex = bytes_to_hex((const uint8_t *)buf, (size_t)read_size);
        free(buf);
        if (!hex) {
            dsl_dataset_rele(ds, FTAG);
            dsl_pool_config_exit(spa->spa_dsl_pool, FTAG);
            return make_error(ENOMEM, "failed to encode read buffer to hex");
        }
    } else {
        hex = strdup("");
        if (!hex) {
            dsl_dataset_rele(ds, FTAG);
            dsl_pool_config_exit(spa->spa_dsl_pool, FTAG);
            return make_error(ENOMEM, "failed to allocate empty hex string");
        }
    }

    eof = (offset >= max_offset) || (offset + read_size >= max_offset);

    hex_json = json_string(hex);
    free(hex);
    if (!hex_json) {
        dsl_dataset_rele(ds, FTAG);
        dsl_pool_config_exit(spa->spa_dsl_pool, FTAG);
        return make_error(ENOMEM, "failed to encode data hex JSON");
    }

    result_json = json_format(
        "{"
        "\"objset_id\":%llu,"
        "\"id\":%llu,"
        "\"offset\":%llu,"
        "\"requested\":%llu,"
        "\"size\":%llu,"
        "\"max_offset\":%llu,"
        "\"eof\":%s,"
        "\"data_hex\":%s"
        "}",
        (unsigned long long)objset_id,
        (unsigned long long)objid,
        (unsigned long long)offset,
        (unsigned long long)request_limit,
        (unsigned long long)read_size,
        (unsigned long long)max_offset,
        eof ? "true" : "false",
        hex_json);
    free(hex_json);
    dsl_dataset_rele(ds, FTAG);
    dsl_pool_config_exit(spa->spa_dsl_pool, FTAG);

    if (!result_json)
        return make_error(ENOMEM, "failed to allocate JSON result");

    return make_success(result_json);
}
