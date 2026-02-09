#include "zdbdecode_internal.h"

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
