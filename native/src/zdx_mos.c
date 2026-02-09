#include "zdbdecode_internal.h"

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
        last_obj = object;

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
    }

    if (err != 0 && err != ENOENT && err != ESRCH && err != EXDEV
#ifdef EBADE
        && err != EBADE
#endif
    ) {
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
        free(bonus_decoded);
        bonus_decoded = json_format(
            "{"
            "\"kind\":\"dsl_dataset\","
            "\"dir_obj\":%llu,"
            "\"prev_snap_obj\":%llu,"
            "\"next_snap_obj\":%llu,"
            "\"snapnames_zapobj\":%llu,"
            "\"deadlist_obj\":%llu,"
            "\"next_clones_obj\":%llu,"
            "\"props_obj\":%llu,"
            "\"userrefs_obj\":%llu,"
            "\"num_children\":%llu,"
            "\"creation_time\":%llu,"
            "\"creation_txg\":%llu,"
            "\"referenced_bytes\":%llu,"
            "\"compressed_bytes\":%llu,"
            "\"uncompressed_bytes\":%llu,"
            "\"unique_bytes\":%llu,"
            "\"fsid_guid\":%llu,"
            "\"guid\":%llu,"
            "\"flags\":%llu"
            "}",
            (unsigned long long)ds->ds_dir_obj,
            (unsigned long long)ds->ds_prev_snap_obj,
            (unsigned long long)ds->ds_next_snap_obj,
            (unsigned long long)ds->ds_snapnames_zapobj,
            (unsigned long long)ds->ds_deadlist_obj,
            (unsigned long long)ds->ds_next_clones_obj,
            (unsigned long long)ds->ds_props_obj,
            (unsigned long long)ds->ds_userrefs_obj,
            (unsigned long long)ds->ds_num_children,
            (unsigned long long)ds->ds_creation_time,
            (unsigned long long)ds->ds_creation_txg,
            (unsigned long long)ds->ds_referenced_bytes,
            (unsigned long long)ds->ds_compressed_bytes,
            (unsigned long long)ds->ds_uncompressed_bytes,
            (unsigned long long)ds->ds_unique_bytes,
            (unsigned long long)ds->ds_fsid_guid,
            (unsigned long long)ds->ds_guid,
            (unsigned long long)ds->ds_flags);

        if (!bonus_decoded) {
            free(edges);
            free(type_name);
            free(bonus_name);
            dnode_rele(dn, FTAG);
            return make_error(ENOMEM, "failed to allocate bonus JSON");
        }

        if (ds->ds_dir_obj != 0) {
            if (append_semantic_edge(&edges, &edge_count, objid,
                ds->ds_dir_obj, "dir_obj", "dsl_dataset_dir_obj",
                1.0) != 0) {
                free(edges);
                free(bonus_decoded);
                free(type_name);
                free(bonus_name);
                dnode_rele(dn, FTAG);
                return make_error(ENOMEM, "failed to append edge");
            }
        }
        if (ds->ds_prev_snap_obj != 0) {
            if (append_semantic_edge(&edges, &edge_count, objid,
                ds->ds_prev_snap_obj, "prev_snap_obj",
                "dsl_dataset_prev_snap_obj", 1.0) != 0) {
                free(edges);
                free(bonus_decoded);
                free(type_name);
                free(bonus_name);
                dnode_rele(dn, FTAG);
                return make_error(ENOMEM, "failed to append edge");
            }
        }
        if (ds->ds_next_snap_obj != 0) {
            if (append_semantic_edge(&edges, &edge_count, objid,
                ds->ds_next_snap_obj, "next_snap_obj",
                "dsl_dataset_next_snap_obj", 1.0) != 0) {
                free(edges);
                free(bonus_decoded);
                free(type_name);
                free(bonus_name);
                dnode_rele(dn, FTAG);
                return make_error(ENOMEM, "failed to append edge");
            }
        }
        if (ds->ds_snapnames_zapobj != 0) {
            if (append_semantic_edge(&edges, &edge_count, objid,
                ds->ds_snapnames_zapobj, "snapnames_zapobj",
                "dsl_dataset_snapnames_zapobj", 1.0) != 0) {
                free(edges);
                free(bonus_decoded);
                free(type_name);
                free(bonus_name);
                dnode_rele(dn, FTAG);
                return make_error(ENOMEM, "failed to append edge");
            }
        }
        if (ds->ds_deadlist_obj != 0) {
            if (append_semantic_edge(&edges, &edge_count, objid,
                ds->ds_deadlist_obj, "deadlist_obj",
                "dsl_dataset_deadlist_obj", 1.0) != 0) {
                free(edges);
                free(bonus_decoded);
                free(type_name);
                free(bonus_name);
                dnode_rele(dn, FTAG);
                return make_error(ENOMEM, "failed to append edge");
            }
        }
        if (ds->ds_next_clones_obj != 0) {
            if (append_semantic_edge(&edges, &edge_count, objid,
                ds->ds_next_clones_obj, "next_clones_obj",
                "dsl_dataset_next_clones_obj", 1.0) != 0) {
                free(edges);
                free(bonus_decoded);
                free(type_name);
                free(bonus_name);
                dnode_rele(dn, FTAG);
                return make_error(ENOMEM, "failed to append edge");
            }
        }
        if (ds->ds_props_obj != 0) {
            if (append_semantic_edge(&edges, &edge_count, objid,
                ds->ds_props_obj, "props_obj",
                "dsl_dataset_props_obj", 1.0) != 0) {
                free(edges);
                free(bonus_decoded);
                free(type_name);
                free(bonus_name);
                dnode_rele(dn, FTAG);
                return make_error(ENOMEM, "failed to append edge");
            }
        }
        if (ds->ds_userrefs_obj != 0) {
            if (append_semantic_edge(&edges, &edge_count, objid,
                ds->ds_userrefs_obj, "userrefs_obj",
                "dsl_dataset_userrefs_obj", 1.0) != 0) {
                free(edges);
                free(bonus_decoded);
                free(type_name);
                free(bonus_name);
                dnode_rele(dn, FTAG);
                return make_error(ENOMEM, "failed to append edge");
            }
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
