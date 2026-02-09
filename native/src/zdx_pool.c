#include "zdbdecode_internal.h"

/*
 * Convert an nvlist to a JSON string using libnvpair JSON printer.
 */
static char *
nvlist_to_json_string(nvlist_t *nvl)
{
    if (!nvl)
        return NULL;

    char *buf = NULL;
    size_t len = 0;
    FILE *fp = open_memstream(&buf, &len);
    if (!fp)
        return NULL;

    if (nvlist_print_json(fp, nvl) != 0) {
        fclose(fp);
        free(buf);
        return NULL;
    }

    if (fclose(fp) != 0) {
        free(buf);
        return NULL;
    }

    return buf;
}

/*
 * Extract host identity from the on-disk MOS config object, which mirrors
 * what zdb shows under "MOS Configuration".
 */
static int
pool_host_identity_from_mos(spa_t *spa, uint64_t *hostid_out, char **hostname_out)
{
    objset_t *mos;
    dmu_buf_t *db = NULL;
    uint64_t nvsize = 0;
    char *packed = NULL;
    nvlist_t *nvl = NULL;
    int err = 0;

    if (!spa || !hostid_out || !hostname_out)
        return EINVAL;

    *hostid_out = 0;
    *hostname_out = NULL;

    mos = spa_meta_objset(spa);
    if (!mos || spa->spa_config_object == 0)
        return ENOENT;

    err = dmu_bonus_hold(mos, spa->spa_config_object, FTAG, &db);
    if (err != 0)
        return err;

    nvsize = *(uint64_t *)db->db_data;
    dmu_buf_rele(db, FTAG);
    db = NULL;

    if (nvsize == 0)
        return ENOENT;

    packed = malloc(nvsize);
    if (!packed)
        return ENOMEM;

    err = dmu_read(mos, spa->spa_config_object, 0, nvsize, packed,
        DMU_READ_PREFETCH);
    if (err != 0) {
        free(packed);
        return err;
    }

    if (nvlist_unpack(packed, nvsize, &nvl, 0) != 0) {
        free(packed);
        return EIO;
    }
    free(packed);

    (void) nvlist_lookup_uint64(nvl, ZPOOL_CONFIG_HOSTID, hostid_out);

    const char *host = NULL;
    if (nvlist_lookup_string(nvl, ZPOOL_CONFIG_HOSTNAME, &host) == 0 &&
        host != NULL) {
        *hostname_out = strdup(host);
        if (*hostname_out == NULL) {
            nvlist_free(nvl);
            return ENOMEM;
        }
    }

    nvlist_free(nvl);
    return 0;
}

/*
 * Build a JSON array of feature names from "features_for_read".
 */
static char *
pool_features_json(nvlist_t *config)
{
    char *array = json_array_start();
    if (!array)
        return NULL;

    int count = 0;
    nvlist_t *features = NULL;
    if (nvlist_lookup_nvlist(config, ZPOOL_CONFIG_FEATURES_FOR_READ,
        &features) == 0 && features != NULL) {
        for (nvpair_t *pair = nvlist_next_nvpair(features, NULL);
            pair != NULL;
            pair = nvlist_next_nvpair(features, pair)) {
            const char *name = nvpair_name(pair);
            if (!name)
                continue;

            char *name_json = json_string(name);
            if (!name_json) {
                free(array);
                return NULL;
            }

            char *next = json_array_append(array, name_json);
            free(name_json);
            if (!next) {
                free(array);
                return NULL;
            }

            free(array);
            array = next;
            count++;
        }
    }

    char *final_json = json_array_end(array, count > 0);
    free(array);
    return final_json;
}

/*
 * Build a compact rootbp summary JSON for the active uberblock.
 */
static char *
rootbp_json(const blkptr_t *bp)
{
    if (!bp)
        return NULL;

    char *dvas = json_array_start();
    if (!dvas)
        return NULL;

    int dva_count = 0;
    for (int i = 0; i < SPA_DVAS_PER_BP; i++) {
        const dva_t *dva = &bp->blk_dva[i];
        if (!DVA_IS_VALID(dva))
            continue;

        char *item = json_format(
            "{\"vdev\":%llu,\"offset\":%llu,\"asize\":%llu,\"is_gang\":%s}",
            (unsigned long long)DVA_GET_VDEV(dva),
            (unsigned long long)DVA_GET_OFFSET(dva),
            (unsigned long long)DVA_GET_ASIZE(dva),
            DVA_GET_GANG(dva) ? "true" : "false");
        if (!item) {
            free(dvas);
            return NULL;
        }

        char *next = json_array_append(dvas, item);
        free(item);
        if (!next) {
            free(dvas);
            return NULL;
        }
        free(dvas);
        dvas = next;
        dva_count++;
    }

    char *dvas_json = json_array_end(dvas, dva_count > 0);
    free(dvas);
    if (!dvas_json)
        return NULL;

    char *result = json_format(
        "{"
        "\"is_hole\":%s,"
        "\"level\":%u,"
        "\"type\":%u,"
        "\"lsize\":%llu,"
        "\"psize\":%llu,"
        "\"asize\":%llu,"
        "\"birth_txg\":%llu,"
        "\"dvas\":%s"
        "}",
        BP_IS_HOLE(bp) ? "true" : "false",
        (unsigned)BP_GET_LEVEL(bp),
        (unsigned)BP_GET_TYPE(bp),
        (unsigned long long)BP_GET_LSIZE(bp),
        (unsigned long long)BP_GET_PSIZE(bp),
        (unsigned long long)BP_GET_ASIZE(bp),
        (unsigned long long)BP_GET_PHYSICAL_BIRTH(bp),
        dvas_json);
    free(dvas_json);
    return result;
}

#define ZDX_ERRLOG_SCAN_STOP 1

typedef struct zdx_errlog_page {
    uint64_t cursor;
    uint64_t limit;
    uint64_t seen;
    uint64_t added;
    boolean_t has_more;
    char *entries_json;
    int entries_count;
    zpool_handle_t *zhp;
} zdx_errlog_page_t;

static int
parse_u64_token_base(const char *s, int base, const char **next, uint64_t *value)
{
    const char *p = s;
    uint64_t acc = 0;
    int saw_digit = 0;

    if (s == NULL || value == NULL || (base != 10 && base != 16))
        return EINVAL;

    while (*p != '\0') {
        int digit = -1;
        if (*p >= '0' && *p <= '9') {
            digit = *p - '0';
        } else if (base == 16 && *p >= 'a' && *p <= 'f') {
            digit = 10 + (*p - 'a');
        } else if (base == 16 && *p >= 'A' && *p <= 'F') {
            digit = 10 + (*p - 'A');
        }

        if (digit < 0 || digit >= base)
            break;

        saw_digit = 1;
        if (acc > ((UINT64_MAX - (uint64_t)digit) / (uint64_t)base))
            return ERANGE;
        acc = (acc * (uint64_t)base) + (uint64_t)digit;
        p++;
    }

    if (!saw_digit)
        return EINVAL;
    if (next != NULL)
        *next = p;
    *value = acc;
    return 0;
}

static int
parse_bookmark_key(const char *name, uint64_t *dsobj, uint64_t *object,
    int64_t *level, uint64_t *blkid)
{
    const char *p = name;
    uint64_t lvl = 0;

    if (parse_u64_token_base(p, 16, &p, dsobj) != 0 || *p != ':')
        return EINVAL;
    p++;
    if (parse_u64_token_base(p, 16, &p, object) != 0 || *p != ':')
        return EINVAL;
    p++;
    if (parse_u64_token_base(p, 16, &p, &lvl) != 0 || *p != ':')
        return EINVAL;
    p++;
    if (parse_u64_token_base(p, 16, &p, blkid) != 0 || *p != '\0')
        return EINVAL;

    *level = (int64_t)lvl;
    return 0;
}

static int
parse_errphys_key(const char *name, uint64_t *object, int64_t *level,
    uint64_t *blkid, uint64_t *birth)
{
    const char *p = name;
    uint64_t lvl = 0;

    if (parse_u64_token_base(p, 16, &p, object) != 0 || *p != ':')
        return EINVAL;
    p++;
    if (parse_u64_token_base(p, 16, &p, &lvl) != 0 || *p != ':')
        return EINVAL;
    p++;
    if (parse_u64_token_base(p, 16, &p, blkid) != 0 || *p != ':')
        return EINVAL;
    p++;
    if (parse_u64_token_base(p, 16, &p, birth) != 0 || *p != '\0')
        return EINVAL;

    *level = (int64_t)lvl;
    return 0;
}

static int
errlog_page_append(zdx_errlog_page_t *page, const char *source, uint64_t dsobj,
    uint64_t object, int64_t level, uint64_t blkid, uint64_t *birth_opt)
{
    if (page->seen < page->cursor) {
        page->seen++;
        return 0;
    }

    if (page->added >= page->limit) {
        page->has_more = B_TRUE;
        return ZDX_ERRLOG_SCAN_STOP;
    }

    char *source_json = json_string(source);
    if (!source_json)
        return ENOMEM;

    char *path_json = NULL;
    if (page->zhp != NULL) {
        char pathbuf[MAXPATHLEN * 2];
        pathbuf[0] = '\0';
        zpool_obj_to_path(page->zhp, dsobj, object, pathbuf, sizeof (pathbuf));
        if (pathbuf[0] != '\0') {
            path_json = json_string(pathbuf);
        }
    }
    if (!path_json)
        path_json = strdup("null");
    if (!path_json) {
        free(source_json);
        return ENOMEM;
    }

    char birth_buf[32];
    const char *birth_json = "null";
    if (birth_opt != NULL) {
        (void) snprintf(birth_buf, sizeof (birth_buf), "%llu",
            (unsigned long long)*birth_opt);
        birth_json = birth_buf;
    }

    char *item = json_format(
        "{"
        "\"source\":%s,"
        "\"dataset_obj\":%llu,"
        "\"object\":%llu,"
        "\"level\":%lld,"
        "\"blkid\":%llu,"
        "\"birth\":%s,"
        "\"path\":%s"
        "}",
        source_json,
        (unsigned long long)dsobj,
        (unsigned long long)object,
        (long long)level,
        (unsigned long long)blkid,
        birth_json,
        path_json);
    free(source_json);
    free(path_json);
    if (!item)
        return ENOMEM;

    char *next = json_array_append(page->entries_json, item);
    free(item);
    if (!next)
        return ENOMEM;

    free(page->entries_json);
    page->entries_json = next;
    page->entries_count++;
    page->added++;
    page->seen++;
    return 0;
}

static int
scan_errlog_legacy(spa_t *spa, uint64_t obj, const char *source,
    zdx_errlog_page_t *page)
{
    if (obj == 0)
        return 0;

    zap_cursor_t zc;
    zap_attribute_t *za = zap_attribute_alloc();
    if (!za)
        return ENOMEM;

    int err = 0;
    for (zap_cursor_init(&zc, spa->spa_meta_objset, obj);
        zap_cursor_retrieve(&zc, za) == 0;
        zap_cursor_advance(&zc)) {
        uint64_t dsobj = 0, object = 0, blkid = 0;
        int64_t level = 0;
        if (parse_bookmark_key(za->za_name, &dsobj, &object, &level, &blkid) != 0)
            continue;

        err = errlog_page_append(page, source, dsobj, object, level, blkid,
            NULL);
        if (err == ZDX_ERRLOG_SCAN_STOP)
            break;
        if (err != 0)
            break;
    }

    zap_cursor_fini(&zc);
    zap_attribute_free(za);
    return err;
}

static int
scan_errlog_head(spa_t *spa, uint64_t obj, const char *source,
    zdx_errlog_page_t *page)
{
    if (obj == 0)
        return 0;

    zap_cursor_t top;
    zap_attribute_t *top_attr = zap_attribute_alloc();
    if (!top_attr)
        return ENOMEM;

    int err = 0;
    for (zap_cursor_init(&top, spa->spa_meta_objset, obj);
        zap_cursor_retrieve(&top, top_attr) == 0;
        zap_cursor_advance(&top)) {
        const char *end = NULL;
        uint64_t head_ds = 0;
        /*
         * head_errlog uses integer-key ZAP entries encoded as lowercase hex.
         * Parse strictly as hex and require full-string consumption to avoid
         * truncating keys like "1eec33d" to decimal "1".
         */
        if (parse_u64_token_base(top_attr->za_name, 16, &end, &head_ds) != 0 ||
            end == NULL || *end != '\0') {
            continue;
        }

        uint64_t head_obj = top_attr->za_first_integer;
        if (head_obj == 0)
            continue;

        zap_cursor_t child;
        zap_attribute_t *child_attr = zap_attribute_alloc();
        if (!child_attr) {
            err = ENOMEM;
            break;
        }

        for (zap_cursor_init(&child, spa->spa_meta_objset, head_obj);
            zap_cursor_retrieve(&child, child_attr) == 0;
            zap_cursor_advance(&child)) {
            uint64_t object = 0, blkid = 0, birth = 0;
            int64_t level = 0;
            if (parse_errphys_key(child_attr->za_name, &object, &level, &blkid,
                &birth) != 0) {
                continue;
            }

            err = errlog_page_append(page, source, head_ds, object, level,
                blkid, &birth);
            if (err == ZDX_ERRLOG_SCAN_STOP)
                break;
            if (err != 0)
                break;
        }

        zap_cursor_fini(&child);
        zap_attribute_free(child_attr);

        if (err == ZDX_ERRLOG_SCAN_STOP || err != 0)
            break;
    }

    zap_cursor_fini(&top);
    zap_attribute_free(top_attr);
    return err;
}

/*
 * Return paginated persistent error-log entries for a pool.
 */
zdx_result_t
zdx_pool_errors(zdx_pool_t *pool, uint64_t cursor, uint64_t limit,
    int resolve_paths)
{
    if (!pool || !pool->spa)
        return make_error(EINVAL, "pool not open");

    spa_t *spa = pool->spa;
    if (limit == 0)
        limit = 200;
    if (limit > 5000)
        limit = 5000;

    uint64_t errcount = 0;
    spa_config_enter(spa, SCL_CONFIG, FTAG, RW_READER);
    if (spa->spa_config != NULL) {
        (void) nvlist_lookup_uint64(spa->spa_config, ZPOOL_CONFIG_ERRCOUNT,
            &errcount);
    }
    spa_config_exit(spa, SCL_CONFIG, FTAG);

    uint64_t approx = spa_approx_errlog_size(spa);
    uint64_t errlog_last = 0;
    uint64_t errlog_scrub = 0;

    mutex_enter(&spa->spa_errlog_lock);
    errlog_last = spa->spa_errlog_last;
    errlog_scrub = spa->spa_errlog_scrub;
    mutex_exit(&spa->spa_errlog_lock);

    boolean_t head_feature = spa_feature_is_enabled(spa, SPA_FEATURE_HEAD_ERRLOG);

    zpool_handle_t *zhp = NULL;
    if (resolve_paths && g_zfs != NULL && !pool->offline_mode)
        zhp = zpool_open_canfail(g_zfs, pool->name);

    zdx_errlog_page_t page = { 0 };
    page.cursor = cursor;
    page.limit = limit;
    page.entries_json = json_array_start();
    page.zhp = zhp;
    if (!page.entries_json) {
        if (zhp)
            zpool_close(zhp);
        return make_error(ENOMEM, "failed to allocate JSON array");
    }

    int scan_err = 0;
    if (head_feature) {
        scan_err = scan_errlog_head(spa, errlog_scrub, "scrub", &page);
        if (scan_err == 0 && !spa->spa_scrub_finished) {
            scan_err = scan_errlog_head(spa, errlog_last, "last", &page);
        }
    } else {
        scan_err = scan_errlog_legacy(spa, errlog_scrub, "scrub", &page);
        if (scan_err == 0 && !spa->spa_scrub_finished) {
            scan_err = scan_errlog_legacy(spa, errlog_last, "last", &page);
        }
    }

    if (zhp)
        zpool_close(zhp);

    if (scan_err != 0 && scan_err != ZDX_ERRLOG_SCAN_STOP) {
        free(page.entries_json);
        return make_error(scan_err, "failed to scan persistent error logs");
    }

    char *entries_final = json_array_end(page.entries_json,
        page.entries_count > 0);
    free(page.entries_json);
    if (!entries_final)
        return make_error(ENOMEM, "failed to finalize error entries JSON");

    char next_buf[32];
    const char *next_json = "null";
    if (page.has_more) {
        (void) snprintf(next_buf, sizeof (next_buf), "%llu",
            (unsigned long long)(cursor + page.added));
        next_json = next_buf;
    }

    char *pool_name_json = json_string(pool->name ? pool->name : "");
    if (!pool_name_json) {
        free(entries_final);
        return make_error(ENOMEM, "failed to encode pool name");
    }

    char *result = json_format(
        "{"
        "\"pool\":%s,"
        "\"error_count\":%llu,"
        "\"approx_entries\":%llu,"
        "\"head_errlog\":%s,"
        "\"errlog_last_obj\":%llu,"
        "\"errlog_scrub_obj\":%llu,"
        "\"cursor\":%llu,"
        "\"limit\":%llu,"
        "\"count\":%llu,"
        "\"next\":%s,"
        "\"entries\":%s"
        "}",
        pool_name_json,
        (unsigned long long)errcount,
        (unsigned long long)approx,
        head_feature ? "true" : "false",
        (unsigned long long)errlog_last,
        (unsigned long long)errlog_scrub,
        (unsigned long long)cursor,
        (unsigned long long)limit,
        (unsigned long long)page.added,
        next_json,
        entries_final);

    free(pool_name_json);
    free(entries_final);

    if (!result)
        return make_error(ENOMEM, "failed to encode pool errors JSON");
    return make_success(result);
}

/*
 * Return a structured pool summary comparable to zdb output.
 */
zdx_result_t
zdx_pool_summary(zdx_pool_t *pool)
{
    if (!pool || !pool->spa)
        return make_error(EINVAL, "pool not open");

    spa_t *spa = pool->spa;
    uint64_t guid = 0, state = 0, txg = 0, version = 0, hostid = 0, errata = 0;
    const char *name = NULL;
    const char *hostname = NULL;
    nvlist_t *config = NULL;
    nvlist_t *vdev_tree = NULL;
    char *hostname_fallback = NULL;

    char *vdev_tree_json = NULL;
    char *features_json = NULL;
    char *name_json = NULL;
    char *hostname_json = NULL;
    char *pool_json = NULL;
    char *rootbp = NULL;
    char *result = NULL;

    spa_config_enter(spa, SCL_CONFIG, FTAG, RW_READER);
    config = spa->spa_config;
    if (config == NULL) {
        spa_config_exit(spa, SCL_CONFIG, FTAG);
        return make_error(EIO, "pool config unavailable");
    }

    (void) nvlist_lookup_string(config, ZPOOL_CONFIG_POOL_NAME, &name);
    (void) nvlist_lookup_uint64(config, ZPOOL_CONFIG_POOL_GUID, &guid);
    (void) nvlist_lookup_uint64(config, ZPOOL_CONFIG_POOL_STATE, &state);
    (void) nvlist_lookup_uint64(config, ZPOOL_CONFIG_POOL_TXG, &txg);
    (void) nvlist_lookup_uint64(config, ZPOOL_CONFIG_VERSION, &version);
    (void) nvlist_lookup_uint64(config, ZPOOL_CONFIG_HOSTID, &hostid);
    (void) nvlist_lookup_string(config, ZPOOL_CONFIG_HOSTNAME, &hostname);
    (void) nvlist_lookup_uint64(config, ZPOOL_CONFIG_ERRATA, &errata);
    (void) nvlist_lookup_nvlist(config, ZPOOL_CONFIG_VDEV_TREE, &vdev_tree);

    /*
     * In read-only opens, the generated in-memory config can carry hostid=0.
     * Prefer host identity from spa_load_info or MOS config to align with zdb.
     */
    if ((hostid == 0 || hostname == NULL) && spa->spa_load_info != NULL) {
        uint64_t load_hostid = 0;
        const char *load_hostname = NULL;
        if (hostid == 0 &&
            nvlist_lookup_uint64(spa->spa_load_info, ZPOOL_CONFIG_HOSTID,
            &load_hostid) == 0 && load_hostid != 0) {
            hostid = load_hostid;
        }
        if (hostname == NULL &&
            nvlist_lookup_string(spa->spa_load_info, ZPOOL_CONFIG_HOSTNAME,
            &load_hostname) == 0 && load_hostname != NULL) {
            hostname = load_hostname;
        }
    }

    if (hostid == 0 || hostname == NULL) {
        uint64_t mos_hostid = 0;
        int host_err = pool_host_identity_from_mos(spa, &mos_hostid,
            &hostname_fallback);
        if (host_err == 0) {
            if (hostid == 0 && mos_hostid != 0)
                hostid = mos_hostid;
            if (hostname == NULL && hostname_fallback != NULL)
                hostname = hostname_fallback;
        } else {
            free(hostname_fallback);
            hostname_fallback = NULL;
        }
    }

    features_json = pool_features_json(config);
    if (!features_json) {
        spa_config_exit(spa, SCL_CONFIG, FTAG);
        free(hostname_fallback);
        return make_error(ENOMEM, "failed to encode features_for_read");
    }

    if (vdev_tree != NULL) {
        vdev_tree_json = nvlist_to_json_string(vdev_tree);
        if (!vdev_tree_json) {
            spa_config_exit(spa, SCL_CONFIG, FTAG);
            free(features_json);
            free(hostname_fallback);
            return make_error(ENOMEM, "failed to encode vdev_tree");
        }
    }
    spa_config_exit(spa, SCL_CONFIG, FTAG);

    uberblock_t ub = { 0 };
    spa_config_enter(spa, SCL_STATE, FTAG, RW_READER);
    ub = spa->spa_uberblock;
    spa_config_exit(spa, SCL_STATE, FTAG);

    rootbp = rootbp_json(&ub.ub_rootbp);
    if (!rootbp) {
        free(features_json);
        free(vdev_tree_json);
        free(hostname_fallback);
        return make_error(ENOMEM, "failed to encode uberblock rootbp");
    }

    name_json = json_string(name ? name : pool->name);
    if (!name_json) {
        free(features_json);
        free(vdev_tree_json);
        free(rootbp);
        free(hostname_fallback);
        return make_error(ENOMEM, "failed to encode pool name");
    }

    if (hostname != NULL) {
        hostname_json = json_string(hostname);
        if (!hostname_json) {
            free(features_json);
            free(vdev_tree_json);
            free(rootbp);
            free(name_json);
            free(hostname_fallback);
            return make_error(ENOMEM, "failed to encode hostname");
        }
    }

    pool_json = json_format(
        "{"
        "\"name\":%s,"
        "\"guid\":%llu,"
        "\"state\":%llu,"
        "\"txg\":%llu,"
        "\"version\":%llu,"
        "\"hostid\":%llu,"
        "\"hostname\":%s,"
        "\"errata\":%llu"
        "}",
        name_json,
        (unsigned long long)guid,
        (unsigned long long)state,
        (unsigned long long)txg,
        (unsigned long long)version,
        (unsigned long long)hostid,
        hostname_json ? hostname_json : "null",
        (unsigned long long)errata);
    free(name_json);
    free(hostname_json);
    free(hostname_fallback);
    if (!pool_json) {
        free(features_json);
        free(vdev_tree_json);
        free(rootbp);
        return make_error(ENOMEM, "failed to encode pool object");
    }

    result = json_format(
        "{"
        "\"pool\":%s,"
        "\"features_for_read\":%s,"
        "\"vdev_tree\":%s,"
        "\"uberblock\":{"
            "\"txg\":%llu,"
            "\"timestamp\":%llu,"
            "\"rootbp\":%s"
        "}"
        "}",
        pool_json,
        features_json,
        vdev_tree_json ? vdev_tree_json : "null",
        (unsigned long long)ub.ub_txg,
        (unsigned long long)ub.ub_timestamp,
        rootbp);
    free(pool_json);
    free(features_json);
    free(vdev_tree_json);
    free(rootbp);

    if (!result)
        return make_error(ENOMEM, "failed to encode pool summary");

    return make_success(result);
}

/*
 * Pool info (compat shim).
 */
zdx_result_t
zdx_pool_info(zdx_pool_t *pool)
{
    return zdx_pool_summary(pool);
}

/*
 * Pool vdevs (compat shim).
 */
zdx_result_t
zdx_pool_vdevs(zdx_pool_t *pool)
{
    return zdx_pool_summary(pool);
}

/*
 * Dataset list callback context
 */
typedef struct dataset_list_ctx {
    char *json;
    int count;
    int err;
} dataset_list_ctx_t;

static const char *
zfs_type_name(zfs_type_t type)
{
    switch (type) {
    case ZFS_TYPE_FILESYSTEM:
        return "filesystem";
    case ZFS_TYPE_SNAPSHOT:
        return "snapshot";
    case ZFS_TYPE_VOLUME:
        return "volume";
    case ZFS_TYPE_POOL:
        return "pool";
    case ZFS_TYPE_BOOKMARK:
        return "bookmark";
    default:
        return "unknown";
    }
}

static int
append_dataset_item(dataset_list_ctx_t *ctx, zfs_handle_t *zhp)
{
    const char *name = zfs_get_name(zhp);
    zfs_type_t type = zfs_get_type(zhp);
    const char *type_name = zfs_type_name(type);

    char *name_json = json_string(name);
    char *type_json = json_string(type_name);
    if (!name_json || !type_json) {
        free(name_json);
        free(type_json);
        ctx->err = ENOMEM;
        return -1;
    }

    char mountpoint[1024] = {0};
    int has_mountpoint = 0;
    int mounted = -1;
    if (type == ZFS_TYPE_FILESYSTEM || type == ZFS_TYPE_VOLUME) {
        if (zfs_prop_get(zhp, ZFS_PROP_MOUNTPOINT, mountpoint, sizeof (mountpoint),
            NULL, NULL, 0, B_FALSE) == 0) {
            has_mountpoint = 1;
        }
        mounted = zfs_is_mounted(zhp, NULL) ? 1 : 0;
    }

    char *item = NULL;
    if (has_mountpoint) {
        char *mount_json = json_string(mountpoint);
        if (!mount_json) {
            free(name_json);
            free(type_json);
            ctx->err = ENOMEM;
            return -1;
        }

        if (mounted >= 0) {
            item = json_format(
                "{\"name\":%s,\"type\":%s,\"mountpoint\":%s,\"mounted\":%s}",
                name_json, type_json, mount_json, mounted ? "true" : "false");
        } else {
            item = json_format(
                "{\"name\":%s,\"type\":%s,\"mountpoint\":%s,\"mounted\":null}",
                name_json, type_json, mount_json);
        }
        free(mount_json);
    } else {
        if (mounted >= 0) {
            item = json_format(
                "{\"name\":%s,\"type\":%s,\"mountpoint\":null,\"mounted\":%s}",
                name_json, type_json, mounted ? "true" : "false");
        } else {
            item = json_format(
                "{\"name\":%s,\"type\":%s,\"mountpoint\":null,\"mounted\":null}",
                name_json, type_json);
        }
    }

    free(name_json);
    free(type_json);

    if (!item) {
        ctx->err = ENOMEM;
        return -1;
    }

    char *new_json = json_array_append(ctx->json, item);
    free(item);
    if (!new_json) {
        ctx->err = ENOMEM;
        return -1;
    }

    free(ctx->json);
    ctx->json = new_json;
    ctx->count++;
    return 0;
}

static int
list_datasets_cb(zfs_handle_t *zhp, void *data)
{
    dataset_list_ctx_t *ctx = (dataset_list_ctx_t *)data;
    if (append_dataset_item(ctx, zhp) != 0) {
        zfs_close(zhp);
        return -1;
    }

    if (zfs_get_type(zhp) == ZFS_TYPE_FILESYSTEM) {
        if (zfs_iter_filesystems(zhp, list_datasets_cb, data) != 0) {
            if (ctx->err == 0)
                ctx->err = EIO;
            zfs_close(zhp);
            return -1;
        }
    }

    zfs_close(zhp);
    return 0;
}

/*
 * List datasets for an open pool.
 */
zdx_result_t
zdx_pool_datasets(zdx_pool_t *pool)
{
    if (!pool)
        return make_error(EINVAL, "pool not open");

    if (!g_zfs)
        return make_error(EINVAL, "libzfs not initialized");

    dataset_list_ctx_t ctx = {0};
    ctx.json = json_array_start();
    if (!ctx.json)
        return make_error(ENOMEM, "failed to allocate JSON array");

    zfs_handle_t *root = zfs_open(g_zfs, pool->name, ZFS_TYPE_FILESYSTEM);
    if (!root) {
        free(ctx.json);
        return make_error(libzfs_errno(g_zfs), "failed to open dataset root: %s",
            pool->name);
    }

    if (list_datasets_cb(root, &ctx) != 0) {
        int err = ctx.err != 0 ? ctx.err : EIO;
        free(ctx.json);
        return make_error(err, "failed to iterate datasets for pool: %s",
            pool->name);
    }

    char *final_json = json_array_end(ctx.json, ctx.count > 0);
    free(ctx.json);
    if (!final_json)
        return make_error(ENOMEM, "failed to finalize JSON");

    return make_success(final_json);
}
