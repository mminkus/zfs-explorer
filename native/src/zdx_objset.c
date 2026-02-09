#include "zdbdecode_internal.h"

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
        result = make_error(err, "dmu_objset_from_ds failed: %s",
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
