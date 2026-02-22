#include "zdbdecode_internal.h"

typedef struct zdx_dsl_dataset_lineage_info {
    uint64_t dsobj;
    uint64_t dir_obj;
    uint64_t prev_snap_obj;
    uint64_t next_snap_obj;
    uint64_t deadlist_obj;
    uint64_t snapnames_zapobj;
    uint64_t next_clones_obj;
    uint64_t creation_txg;
    uint64_t creation_time;
    uint64_t referenced_bytes;
    uint64_t unique_bytes;
} zdx_dsl_dataset_lineage_info_t;

static int
zdx_read_dsl_dataset_lineage_info(objset_t *mos, uint64_t dsobj,
    zdx_dsl_dataset_lineage_info_t *info)
{
    if (!mos || !info || dsobj == 0)
        return EINVAL;

    dnode_t *dn = NULL;
    int err = dnode_hold(mos, dsobj, FTAG, &dn);
    if (err != 0)
        return err;

    dmu_object_info_t doi;
    dmu_object_info_from_dnode(dn, &doi);
    if (doi.doi_bonus_type != DMU_OT_DSL_DATASET ||
        dn->dn_bonuslen < sizeof (dsl_dataset_phys_t)) {
        dnode_rele(dn, FTAG);
        return EINVAL;
    }

    dsl_dataset_phys_t *ds = (dsl_dataset_phys_t *)DN_BONUS(dn->dn_phys);
    info->dsobj = dsobj;
    info->dir_obj = ds->ds_dir_obj;
    info->prev_snap_obj = ds->ds_prev_snap_obj;
    info->next_snap_obj = ds->ds_next_snap_obj;
    info->deadlist_obj = ds->ds_deadlist_obj;
    info->snapnames_zapobj = ds->ds_snapnames_zapobj;
    info->next_clones_obj = ds->ds_next_clones_obj;
    info->creation_txg = ds->ds_creation_txg;
    info->creation_time = ds->ds_creation_time;
    info->referenced_bytes = ds->ds_referenced_bytes;
    info->unique_bytes = ds->ds_unique_bytes;

    dnode_rele(dn, FTAG);
    return 0;
}

static boolean_t
zdx_id_in_info_array(const zdx_dsl_dataset_lineage_info_t *items, uint64_t count,
    uint64_t dsobj)
{
    for (uint64_t i = 0; i < count; i++) {
        if (items[i].dsobj == dsobj)
            return (B_TRUE);
    }
    return (B_FALSE);
}

static boolean_t
zdx_dataset_in_special_dir(const dsl_dataset_t *ds, const char *special_name)
{
    if (!ds || !ds->ds_dir || !special_name)
        return (B_FALSE);

    if (strcmp(ds->ds_dir->dd_myname, special_name) == 0)
        return (B_TRUE);

    /*
     * dd_myname is expected to be the leaf DSL dir name, but fall back to
     * dsl_dir_name() for robustness across builds/layouts.
     */
    char dir_name[ZFS_MAX_DATASET_NAME_LEN];
    dsl_dir_name(ds->ds_dir, dir_name);
    const char *leaf = strrchr(dir_name, '/');
    leaf = (leaf != NULL) ? (leaf + 1) : dir_name;

    return (strcmp(leaf, special_name) == 0);
}

static char *
zdx_lineage_item_json(const zdx_dsl_dataset_lineage_info_t *info, boolean_t is_start)
{
    if (!info)
        return NULL;

    return json_format(
        "{"
        "\"dsobj\":%llu,"
        "\"dir_obj\":%llu,"
        "\"prev_snap_obj\":%llu,"
        "\"next_snap_obj\":%llu,"
        "\"deadlist_obj\":%llu,"
        "\"snapnames_zapobj\":%llu,"
        "\"next_clones_obj\":%llu,"
        "\"creation_txg\":%llu,"
        "\"creation_time\":%llu,"
        "\"referenced_bytes\":%llu,"
        "\"unique_bytes\":%llu,"
        "\"is_start\":%s"
        "}",
        (unsigned long long)info->dsobj,
        (unsigned long long)info->dir_obj,
        (unsigned long long)info->prev_snap_obj,
        (unsigned long long)info->next_snap_obj,
        (unsigned long long)info->deadlist_obj,
        (unsigned long long)info->snapnames_zapobj,
        (unsigned long long)info->next_clones_obj,
        (unsigned long long)info->creation_txg,
        (unsigned long long)info->creation_time,
        (unsigned long long)info->referenced_bytes,
        (unsigned long long)info->unique_bytes,
        is_start ? "true" : "false");
}

/*
 * DSL dir children
 */
zdx_result_t
zdx_dsl_dir_children(zdx_pool_t *pool, uint64_t objid)
{
    if (!pool || !pool->spa)
        return make_error(EINVAL, "pool not open");

    dsl_pool_t *dp = pool->spa->spa_dsl_pool;
    objset_t *mos = spa_meta_objset(pool->spa);
    if (!mos)
        return make_error(EINVAL, "failed to access MOS");

    dsl_dir_t *dd = NULL;
    int err;
    dsl_pool_config_enter(dp, FTAG);
    err = dsl_dir_hold_obj(dp, objid, NULL, FTAG, &dd);
    if (err != 0)
        goto out_unlock;

    uint64_t zapobj = dsl_dir_phys(dd)->dd_child_dir_zapobj;
    dsl_dir_rele(dd, FTAG);
    dd = NULL;

    char *array = json_array_start();
    if (!array) {
        err = ENOMEM;
        goto out_unlock;
    }
    int count = 0;

    if (zapobj != 0) {
        zap_cursor_t zc;
        zap_cursor_init(&zc, mos, zapobj);
        zap_attribute_t *attrp = zap_attribute_long_alloc();
        if (!attrp) {
            zap_cursor_fini(&zc);
            free(array);
            err = ENOMEM;
            goto out_unlock;
        }

        while ((err = zap_cursor_retrieve(&zc, attrp)) == 0) {
            uint64_t child_obj = 0;
            if (attrp->za_integer_length == 8 &&
                attrp->za_num_integers == 1) {
                (void) zap_lookup(mos, zapobj, attrp->za_name,
                    8, 1, &child_obj);
            }

            /* Skip entries with invalid object IDs. */
            if (child_obj == 0) {
                zap_cursor_advance(&zc);
                continue;
            }

            /*
             * Validate child as a real DSL dir via dsl_dir_hold_obj() while
             * config lock is held.
             */
            dsl_dir_t *child_dd = NULL;
            int child_err = dsl_dir_hold_obj(dp, child_obj, NULL, FTAG,
                &child_dd);
            if (child_err != 0) {
                zap_cursor_advance(&zc);
                continue;
            }
            dsl_dir_rele(child_dd, FTAG);

            char *name_json = json_string(attrp->za_name);
            if (!name_json) {
                zap_attribute_free(attrp);
                zap_cursor_fini(&zc);
                free(array);
                err = ENOMEM;
                goto out_unlock;
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
                err = ENOMEM;
                goto out_unlock;
            }

            char *new_array = json_array_append(array, item);
            free(item);
            if (!new_array) {
                zap_attribute_free(attrp);
                zap_cursor_fini(&zc);
                free(array);
                err = ENOMEM;
                goto out_unlock;
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
            goto out_unlock;
        }

        zap_attribute_free(attrp);
        zap_cursor_fini(&zc);
    } else {
        err = 0;
    }

    char *children_json = json_array_end(array, count > 0);
    free(array);
    if (!children_json) {
        err = ENOMEM;
        goto out_unlock;
    }

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

    if (!result) {
        err = ENOMEM;
        goto out_unlock;
    }

    dsl_pool_config_exit(dp, FTAG);
    return make_success(result);

out_unlock:
    if (dd != NULL)
        dsl_dir_rele(dd, FTAG);
    dsl_pool_config_exit(dp, FTAG);
    if (err == EINVAL)
        return make_error(err, "object %llu is not DSL dir",
            (unsigned long long)objid);
    if (err == ENOMEM)
        return make_error(err, "failed to allocate JSON result");
    if (err == ENOENT)
        return make_error(err, "dsl_dir_children lookup failed: %s",
            strerror(err));
    if (err != 0)
        return make_error(err, "dsl_dir_children failed: %s", strerror(err));
    return make_error(EFAULT, "dsl_dir_children failed");
}

/*
 * DSL dir head dataset
 */
zdx_result_t
zdx_dsl_dir_head(zdx_pool_t *pool, uint64_t objid)
{
    if (!pool || !pool->spa)
        return make_error(EINVAL, "pool not open");

    dsl_pool_t *dp = pool->spa->spa_dsl_pool;
    dsl_dir_t *dd = NULL;
    int err;
    uint64_t head;

    dsl_pool_config_enter(dp, FTAG);
    err = dsl_dir_hold_obj(dp, objid, NULL, FTAG, &dd);
    if (err != 0) {
        dsl_pool_config_exit(dp, FTAG);
        return make_error(err, "dsl_dir_hold_obj failed for object %llu",
            (unsigned long long)objid);
    }

    head = dsl_dir_phys(dd)->dd_head_dataset_obj;
    dsl_dir_rele(dd, FTAG);
    dsl_pool_config_exit(dp, FTAG);

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

    dsl_pool_t *dp = pool->spa->spa_dsl_pool;
    uint64_t root_dir = 0;
    uint64_t root_dataset = 0;
    int err;
    dsl_dir_t *root_dd = NULL;

    dsl_pool_config_enter(dp, FTAG);
    /*
     * Resolve the pool root directory by name under dp_config_rwlock.
     * This is more robust across on-disk layout/version differences than
     * relying solely on a raw MOS zap lookup.
     */
    err = dsl_dir_hold(dp, spa_name(pool->spa), FTAG, &root_dd, NULL);
    if (err != 0)
        goto out_unlock;

    root_dir = root_dd->dd_object;
    root_dataset = dsl_dir_phys(root_dd)->dd_head_dataset_obj;
    dsl_dir_rele(root_dd, FTAG);
    root_dd = NULL;
    dsl_pool_config_exit(dp, FTAG);

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

out_unlock:
    if (root_dd != NULL)
        dsl_dir_rele(root_dd, FTAG);
    dsl_pool_config_exit(dp, FTAG);
    return make_error(err, "failed to resolve root dir: %s", strerror(err));
}

/*
 * Resolve DSL directory metadata by dataset name.
 */
zdx_result_t
zdx_dsl_dir_by_name(zdx_pool_t *pool, const char *name)
{
    if (!pool || !pool->spa)
        return make_error(EINVAL, "pool not open");
    if (!name || name[0] == '\0')
        return make_error(EINVAL, "dataset name is empty");

    dsl_pool_t *dp = pool->spa->spa_dsl_pool;
    dsl_dir_t *dd = NULL;
    int err;
    uint64_t dir_obj = 0;
    uint64_t head_obj = 0;

    dsl_pool_config_enter(dp, FTAG);
    err = dsl_dir_hold(dp, name, FTAG, &dd, NULL);
    if (err != 0) {
        dsl_pool_config_exit(dp, FTAG);
        return make_error(err, "dsl_dir_hold failed for '%s': %s",
            name, strerror(err));
    }

    dir_obj = dd->dd_object;
    head_obj = dsl_dir_phys(dd)->dd_head_dataset_obj;
    dsl_dir_rele(dd, FTAG);
    dsl_pool_config_exit(dp, FTAG);

    char *name_json = json_string(name);
    if (!name_json)
        return make_error(ENOMEM, "failed to encode dataset name");
    char *result = json_format(
        "{"
        "\"name\":%s,"
        "\"dir_objid\":%llu,"
        "\"head_dataset_obj\":%llu"
        "}",
        name_json,
        (unsigned long long)dir_obj,
        (unsigned long long)head_obj);
    free(name_json);
    if (!result)
        return make_error(ENOMEM, "failed to allocate JSON result");

    return make_success(result);
}

/*
 * Snapshot list for a DSL directory
 */
zdx_result_t
zdx_dataset_snapshots(zdx_pool_t *pool, uint64_t dir_obj)
{
    if (!pool || !pool->spa)
        return make_error(EINVAL, "pool not open");

    objset_t *mos = spa_meta_objset(pool->spa);
    if (!mos)
        return make_error(EINVAL, "failed to access MOS");

    dnode_t *dir_dn = NULL;
    int err = dnode_hold(mos, dir_obj, FTAG, &dir_dn);
    if (err != 0) {
        return make_error(err, "dnode_hold failed for DSL dir %llu",
            (unsigned long long)dir_obj);
    }

    dmu_object_info_t dir_doi;
    dmu_object_info_from_dnode(dir_dn, &dir_doi);
    if (dir_doi.doi_bonus_type != DMU_OT_DSL_DIR ||
        dir_dn->dn_bonuslen < sizeof (dsl_dir_phys_t)) {
        dnode_rele(dir_dn, FTAG);
        return make_error(EINVAL, "object %llu is not DSL dir",
            (unsigned long long)dir_obj);
    }

    dsl_dir_phys_t *dd = (dsl_dir_phys_t *)DN_BONUS(dir_dn->dn_phys);
    uint64_t head_dataset_obj = dd->dd_head_dataset_obj;
    dnode_rele(dir_dn, FTAG);

    if (head_dataset_obj == 0) {
        return make_error(EINVAL, "DSL dir %llu has no head dataset",
            (unsigned long long)dir_obj);
    }

    dnode_t *ds_dn = NULL;
    err = dnode_hold(mos, head_dataset_obj, FTAG, &ds_dn);
    if (err != 0) {
        return make_error(err, "dnode_hold failed for dataset %llu",
            (unsigned long long)head_dataset_obj);
    }

    dmu_object_info_t ds_doi;
    dmu_object_info_from_dnode(ds_dn, &ds_doi);
    if (ds_doi.doi_bonus_type != DMU_OT_DSL_DATASET ||
        ds_dn->dn_bonuslen < sizeof (dsl_dataset_phys_t)) {
        dnode_rele(ds_dn, FTAG);
        return make_error(EINVAL, "head dataset bonus unsupported");
    }

    dsl_dataset_phys_t *ds = (dsl_dataset_phys_t *)DN_BONUS(ds_dn->dn_phys);
    uint64_t snapnames_zapobj = ds->ds_snapnames_zapobj;
    dnode_rele(ds_dn, FTAG);

    char *entries = json_array_start();
    if (!entries)
        return make_error(ENOMEM, "failed to allocate snapshots array");
    int count = 0;

    if (snapnames_zapobj != 0) {
        zap_cursor_t zc;
        zap_cursor_init(&zc, mos, snapnames_zapobj);
        zap_attribute_t *attrp = zap_attribute_long_alloc();
        if (!attrp) {
            zap_cursor_fini(&zc);
            free(entries);
            return make_error(ENOMEM, "failed to allocate zap attribute");
        }

        while ((err = zap_cursor_retrieve(&zc, attrp)) == 0) {
            uint64_t snap_dsobj = 0;
            if (attrp->za_integer_length != 8 || attrp->za_num_integers != 1) {
                zap_cursor_advance(&zc);
                continue;
            }

            err = zap_lookup(mos, snapnames_zapobj, attrp->za_name, 8, 1,
                &snap_dsobj);
            if (err != 0) {
                zap_cursor_advance(&zc);
                continue;
            }

            char *name_json = json_string(attrp->za_name);
            if (!name_json) {
                zap_attribute_free(attrp);
                zap_cursor_fini(&zc);
                free(entries);
                return make_error(ENOMEM, "failed to allocate snapshot name");
            }

            char *item = json_format(
                "{\"name\":%s,\"dsobj\":%llu}",
                name_json,
                (unsigned long long)snap_dsobj);
            free(name_json);
            if (!item) {
                zap_attribute_free(attrp);
                zap_cursor_fini(&zc);
                free(entries);
                return make_error(ENOMEM, "failed to allocate snapshot item");
            }

            char *new_entries = json_array_append(entries, item);
            free(item);
            if (!new_entries) {
                zap_attribute_free(attrp);
                zap_cursor_fini(&zc);
                free(entries);
                return make_error(ENOMEM, "failed to append snapshot item");
            }

            free(entries);
            entries = new_entries;
            count++;
            zap_cursor_advance(&zc);
        }

        if (err != 0 && err != ENOENT) {
            zap_attribute_free(attrp);
            zap_cursor_fini(&zc);
            free(entries);
            return make_error(err, "snapshot ZAP traversal failed: %s",
                strerror(err));
        }

        zap_attribute_free(attrp);
        zap_cursor_fini(&zc);
    }

    char *entries_json = json_array_end(entries, count > 0);
    free(entries);
    if (!entries_json)
        return make_error(ENOMEM, "failed to finalize snapshots array");

    char *result = json_format(
        "{"
        "\"dsl_dir_obj\":%llu,"
        "\"head_dataset_obj\":%llu,"
        "\"snapnames_zapobj\":%llu,"
        "\"count\":%d,"
        "\"entries\":%s"
        "}",
        (unsigned long long)dir_obj,
        (unsigned long long)head_dataset_obj,
        (unsigned long long)snapnames_zapobj,
        count,
        entries_json);
    free(entries_json);

    if (!result)
        return make_error(ENOMEM, "failed to allocate JSON result");

    return make_success(result);
}

/*
 * Snapshot count for a DSL directory (cheap metadata-only query).
 */
zdx_result_t
zdx_dataset_snapshot_count(zdx_pool_t *pool, uint64_t dir_obj)
{
    if (!pool || !pool->spa)
        return make_error(EINVAL, "pool not open");

    objset_t *mos = spa_meta_objset(pool->spa);
    if (!mos)
        return make_error(EINVAL, "failed to access MOS");

    dnode_t *dir_dn = NULL;
    int err = dnode_hold(mos, dir_obj, FTAG, &dir_dn);
    if (err != 0) {
        return make_error(err, "dnode_hold failed for DSL dir %llu",
            (unsigned long long)dir_obj);
    }

    dmu_object_info_t dir_doi;
    dmu_object_info_from_dnode(dir_dn, &dir_doi);
    if (dir_doi.doi_bonus_type != DMU_OT_DSL_DIR ||
        dir_dn->dn_bonuslen < sizeof (dsl_dir_phys_t)) {
        dnode_rele(dir_dn, FTAG);
        return make_error(EINVAL, "object %llu is not DSL dir",
            (unsigned long long)dir_obj);
    }

    dsl_dir_phys_t *dd = (dsl_dir_phys_t *)DN_BONUS(dir_dn->dn_phys);
    uint64_t head_dataset_obj = dd->dd_head_dataset_obj;
    dnode_rele(dir_dn, FTAG);

    if (head_dataset_obj == 0) {
        return make_error(EINVAL, "DSL dir %llu has no head dataset",
            (unsigned long long)dir_obj);
    }

    dnode_t *ds_dn = NULL;
    err = dnode_hold(mos, head_dataset_obj, FTAG, &ds_dn);
    if (err != 0) {
        return make_error(err, "dnode_hold failed for dataset %llu",
            (unsigned long long)head_dataset_obj);
    }

    dmu_object_info_t ds_doi;
    dmu_object_info_from_dnode(ds_dn, &ds_doi);
    if (ds_doi.doi_bonus_type != DMU_OT_DSL_DATASET ||
        ds_dn->dn_bonuslen < sizeof (dsl_dataset_phys_t)) {
        dnode_rele(ds_dn, FTAG);
        return make_error(EINVAL, "head dataset bonus unsupported");
    }

    dsl_dataset_phys_t *ds = (dsl_dataset_phys_t *)DN_BONUS(ds_dn->dn_phys);
    uint64_t snapnames_zapobj = ds->ds_snapnames_zapobj;
    dnode_rele(ds_dn, FTAG);

    uint64_t count = 0;
    if (snapnames_zapobj != 0) {
        err = zap_count(mos, snapnames_zapobj, &count);
        if (err != 0) {
            return make_error(err, "failed to count snapshots for DSL dir %llu",
                (unsigned long long)dir_obj);
        }
    }

    char *result = json_format(
        "{"
        "\"dsl_dir_obj\":%llu,"
        "\"head_dataset_obj\":%llu,"
        "\"snapnames_zapobj\":%llu,"
        "\"count\":%llu"
        "}",
        (unsigned long long)dir_obj,
        (unsigned long long)head_dataset_obj,
        (unsigned long long)snapnames_zapobj,
        (unsigned long long)count);

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
    int err;

    dsl_pool_config_enter(spa->spa_dsl_pool, FTAG);
    err = dsl_dataset_hold_obj(spa->spa_dsl_pool, dsobj, FTAG, &ds);
    if (err != 0) {
        dsl_pool_config_exit(spa->spa_dsl_pool, FTAG);
        return make_error(err, "dsl_dataset_hold_obj failed: %s",
            strerror(err));
    }

    /*
     * Internal datasets ($ORIGIN, $MOS, $FREE) are not user-visible ZPL
     * filesystems. Guard before dmu_objset_from_ds() so we return a normal
     * error instead of tripping assertions in lower layers.
     */
    if (zdx_dataset_in_special_dir(ds, ORIGIN_DIR_NAME)) {
        dsl_dataset_rele(ds, FTAG);
        dsl_pool_config_exit(spa->spa_dsl_pool, FTAG);
        return make_error(EINVAL,
            "dataset %llu is $ORIGIN and has no user-visible ZPL objset",
            (unsigned long long)dsobj);
    }

    if (zdx_dataset_in_special_dir(ds, MOS_DIR_NAME)) {
        dsl_dataset_rele(ds, FTAG);
        dsl_pool_config_exit(spa->spa_dsl_pool, FTAG);
        return make_error(EINVAL,
            "dataset %llu is $MOS and has no user-visible ZPL objset",
            (unsigned long long)dsobj);
    }

    if (zdx_dataset_in_special_dir(ds, FREE_DIR_NAME)) {
        dsl_dataset_rele(ds, FTAG);
        dsl_pool_config_exit(spa->spa_dsl_pool, FTAG);
        return make_error(EINVAL,
            "dataset %llu is $FREE and has no user-visible ZPL objset",
            (unsigned long long)dsobj);
    }

    /*
     * In OpenZFS the objset ID equals the DSL dataset object ID.
     * Avoid dmu_objset_from_ds() entirely: opening the objset triggers
     * background eviction activity (dbu_evict) that can assert in
     * bpobj_iterate_impl on some Linux environments (Ubuntu 24.04).
     * We never use the objset_t pointer here, so skip it.
     */
    uint64_t objset_id = dsobj;

    dsl_dataset_rele(ds, FTAG);
    dsl_pool_config_exit(spa->spa_dsl_pool, FTAG);

    /*
     * NOTE: Avoid reading ds_bp under ds_bp_rwlock here.
     * Some environments can stall indefinitely in rrw_enter(),
     * which blocks all subsequent FFI calls (global mutex).
     * We can still return objset_id without the rootbp.
     */
    const char *rootbp_json = "null";

    char *result = json_format(
        "{"
        "\"dataset_obj\":%llu,"
        "\"objset_id\":%llu,"
        "\"rootbp\":%s"
        "}",
        (unsigned long long)dsobj,
        (unsigned long long)objset_id,
        rootbp_json);

    if (!result)
        return make_error(ENOMEM, "failed to allocate JSON result");

    return make_success(result);
}

/*
 * Snapshot lineage around a DSL dataset object.
 */
zdx_result_t
zdx_dataset_lineage(zdx_pool_t *pool, uint64_t dsobj, uint64_t max_prev,
    uint64_t max_next)
{
    if (!pool || !pool->spa)
        return make_error(EINVAL, "pool not open");
    if (dsobj == 0)
        return make_error(EINVAL, "dataset object must be non-zero");

    if (max_prev == 0)
        max_prev = 64;
    if (max_next == 0)
        max_next = 64;

    const uint64_t max_chain_cap = 4096;
    max_prev = MIN(max_prev, max_chain_cap);
    max_next = MIN(max_next, max_chain_cap);

    objset_t *mos = spa_meta_objset(pool->spa);
    if (!mos)
        return make_error(EINVAL, "failed to access MOS");

    zdx_dsl_dataset_lineage_info_t start = { 0 };
    int err = zdx_read_dsl_dataset_lineage_info(mos, dsobj, &start);
    if (err != 0)
        return make_error(err, "object %llu is not a DSL dataset",
            (unsigned long long)dsobj);

    zdx_dsl_dataset_lineage_info_t *prev_items = calloc(max_prev,
        sizeof (*prev_items));
    zdx_dsl_dataset_lineage_info_t *next_items = calloc(max_next,
        sizeof (*next_items));
    if ((!prev_items && max_prev > 0) || (!next_items && max_next > 0)) {
        free(prev_items);
        free(next_items);
        return make_error(ENOMEM, "failed to allocate lineage buffers");
    }

    uint64_t prev_count = 0;
    uint64_t next_count = 0;
    boolean_t prev_truncated = B_FALSE;
    boolean_t next_truncated = B_FALSE;

    uint64_t cur_prev = start.prev_snap_obj;
    while (cur_prev != 0) {
        if (cur_prev == dsobj ||
            zdx_id_in_info_array(prev_items, prev_count, cur_prev) ||
            zdx_id_in_info_array(next_items, next_count, cur_prev)) {
            prev_truncated = B_TRUE;
            break;
        }
        if (prev_count >= max_prev) {
            prev_truncated = B_TRUE;
            break;
        }

        zdx_dsl_dataset_lineage_info_t info = { 0 };
        err = zdx_read_dsl_dataset_lineage_info(mos, cur_prev, &info);
        if (err != 0) {
            free(prev_items);
            free(next_items);
            return make_error(err, "failed to read prev snapshot %llu",
                (unsigned long long)cur_prev);
        }

        prev_items[prev_count++] = info;
        cur_prev = info.prev_snap_obj;
    }

    uint64_t cur_next = start.next_snap_obj;
    while (cur_next != 0) {
        if (cur_next == dsobj ||
            zdx_id_in_info_array(next_items, next_count, cur_next) ||
            zdx_id_in_info_array(prev_items, prev_count, cur_next)) {
            next_truncated = B_TRUE;
            break;
        }
        if (next_count >= max_next) {
            next_truncated = B_TRUE;
            break;
        }

        zdx_dsl_dataset_lineage_info_t info = { 0 };
        err = zdx_read_dsl_dataset_lineage_info(mos, cur_next, &info);
        if (err != 0) {
            free(prev_items);
            free(next_items);
            return make_error(err, "failed to read next snapshot %llu",
                (unsigned long long)cur_next);
        }

        next_items[next_count++] = info;
        cur_next = info.next_snap_obj;
    }

    char *entries = json_array_start();
    if (!entries) {
        free(prev_items);
        free(next_items);
        return make_error(ENOMEM, "failed to allocate lineage JSON array");
    }

    int item_count = 0;
    for (uint64_t i = prev_count; i > 0; i--) {
        char *item = zdx_lineage_item_json(&prev_items[i - 1], B_FALSE);
        if (!item) {
            free(entries);
            free(prev_items);
            free(next_items);
            return make_error(ENOMEM, "failed to allocate lineage item");
        }
        char *next = json_array_append(entries, item);
        free(item);
        if (!next) {
            free(entries);
            free(prev_items);
            free(next_items);
            return make_error(ENOMEM, "failed to append lineage item");
        }
        free(entries);
        entries = next;
        item_count++;
    }

    char *start_item = zdx_lineage_item_json(&start, B_TRUE);
    if (!start_item) {
        free(entries);
        free(prev_items);
        free(next_items);
        return make_error(ENOMEM, "failed to allocate start lineage item");
    }
    char *with_start = json_array_append(entries, start_item);
    free(start_item);
    if (!with_start) {
        free(entries);
        free(prev_items);
        free(next_items);
        return make_error(ENOMEM, "failed to append start lineage item");
    }
    free(entries);
    entries = with_start;
    item_count++;

    for (uint64_t i = 0; i < next_count; i++) {
        char *item = zdx_lineage_item_json(&next_items[i], B_FALSE);
        if (!item) {
            free(entries);
            free(prev_items);
            free(next_items);
            return make_error(ENOMEM, "failed to allocate lineage item");
        }
        char *next = json_array_append(entries, item);
        free(item);
        if (!next) {
            free(entries);
            free(prev_items);
            free(next_items);
            return make_error(ENOMEM, "failed to append lineage item");
        }
        free(entries);
        entries = next;
        item_count++;
    }

    char *entries_json = json_array_end(entries, item_count > 0);
    free(entries);
    free(prev_items);
    free(next_items);
    if (!entries_json)
        return make_error(ENOMEM, "failed to finalize lineage array");

    char *result = json_format(
        "{"
        "\"start_dsobj\":%llu,"
        "\"count\":%d,"
        "\"prev_truncated\":%s,"
        "\"next_truncated\":%s,"
        "\"entries\":%s"
        "}",
        (unsigned long long)dsobj,
        item_count,
        prev_truncated ? "true" : "false",
        next_truncated ? "true" : "false",
        entries_json);
    free(entries_json);

    if (!result)
        return make_error(ENOMEM, "failed to allocate JSON result");

    return make_success(result);
}
