#include "zdbdecode_internal.h"

/* Global libzfs handle */
libzfs_handle_t *g_zfs = NULL;

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
zdx_result_t
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

    if (err > 0) {
        char with_errno[512];
        const char *errtxt = strerror(err);
        (void)snprintf(with_errno, sizeof (with_errno), "%s: %s", buf,
            errtxt ? errtxt : "unknown error");
        result.errmsg = strdup(with_errno);
    } else {
        result.errmsg = strdup(buf);
    }
    return result;
}

/*
 * Create a success result with JSON
 */
zdx_result_t
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
const char *
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

char *
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

char *
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

const char *
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

uint64_t
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

char *
dup_range(const char *start, size_t len)
{
    char *out = malloc(len + 1);
    if (!out)
        return NULL;
    (void)memcpy(out, start, len);
    out[len] = '\0';
    return out;
}

int
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

int
zdx_sa_setup(objset_t *os, sa_attr_type_t **tablep)
{
    uint64_t sa_attrs = 0;
    uint64_t version = 0;
    int err;

    if (dmu_objset_type(os) != DMU_OST_ZFS)
        return EINVAL;

    err = zap_lookup(os, MASTER_NODE_OBJ, ZPL_VERSION_STR, 8, 1, &version);
    if (err == 0 && version >= ZPL_VERSION_SA) {
        (void) zap_lookup(os, MASTER_NODE_OBJ, ZFS_SA_ATTRS, 8, 1, &sa_attrs);
    }

    err = sa_setup(os, sa_attrs, zfs_attr_table, ZPL_END, tablep);
    return err;
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

static void
free_search_paths(char **paths, int count)
{
    if (!paths)
        return;
    for (int i = 0; i < count; i++)
        free(paths[i]);
    free(paths);
}

static int
build_search_paths(const char *search_paths, char ***out_paths, int *out_count)
{
    if (!out_paths || !out_count)
        return EINVAL;

    *out_paths = NULL;
    *out_count = 0;

    if (search_paths != NULL && search_paths[0] != '\0') {
        char *copy = strdup(search_paths);
        if (!copy)
            return ENOMEM;

        int count = 1;
        for (const char *p = search_paths; *p != '\0'; p++) {
            if (*p == ':')
                count++;
        }

        char **paths = calloc((size_t)count, sizeof (char *));
        if (!paths) {
            free(copy);
            return ENOMEM;
        }

        int idx = 0;
        char *iter = copy;
        char *token = NULL;
        while ((token = strsep(&iter, ":")) != NULL) {
            if (token[0] == '\0')
                continue;
            paths[idx] = strdup(token);
            if (!paths[idx]) {
                free(copy);
                free_search_paths(paths, idx);
                return ENOMEM;
            }
            idx++;
        }
        free(copy);

        if (idx == 0) {
            free(paths);
            return EINVAL;
        }

        *out_paths = paths;
        *out_count = idx;
        return 0;
    }

    size_t default_count = 0;
    const char * const *defaults = zpool_default_search_paths(&default_count);
    if (!defaults || default_count == 0)
        return ENOENT;

    char **paths = calloc(default_count, sizeof (char *));
    if (!paths)
        return ENOMEM;

    for (size_t i = 0; i < default_count; i++) {
        paths[i] = strdup(defaults[i]);
        if (!paths[i]) {
            free_search_paths(paths, (int)i);
            return ENOMEM;
        }
    }

    *out_paths = paths;
    *out_count = (int)default_count;
    return 0;
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
 * Open a pool by scanning offline vdevs/paths and importing read-only in-process.
 */
zdx_pool_t *
zdx_pool_open_offline(const char *name, const char *search_paths, int *err)
{
    if (err)
        *err = 0;

    if (name == NULL) {
        if (err)
            *err = EINVAL;
        return NULL;
    }

    char **paths = NULL;
    int path_count = 0;
    int rc = build_search_paths(search_paths, &paths, &path_count);
    if (rc != 0) {
        if (err)
            *err = rc;
        return NULL;
    }

    importargs_t args = { 0 };
    args.paths = path_count;
    args.path = paths;
    args.can_be_active = B_TRUE;
    args.scan = B_TRUE;

    libpc_handle_t lpch = { 0 };
    lpch.lpc_lib_handle = NULL;
    lpch.lpc_ops = &libzpool_config_ops;
    lpch.lpc_printerr = B_TRUE;

    nvlist_t *cfg = NULL;
    rc = zpool_find_config(&lpch, name, &cfg, &args);
    free_search_paths(paths, path_count);
    if (rc != 0 || cfg == NULL) {
        if (err)
            *err = (rc != 0) ? rc : ENOENT;
        return NULL;
    }

    boolean_t imported_offline = B_FALSE;
    char *import_name = strdup(name);
    if (!import_name) {
        nvlist_free(cfg);
        if (err)
            *err = ENOMEM;
        return NULL;
    }

    rc = spa_import(import_name, cfg, NULL, ZFS_IMPORT_SKIP_MMP);
    free(import_name);
    nvlist_free(cfg);
    if (rc == 0) {
        imported_offline = B_TRUE;
    } else if (rc != EEXIST
#ifdef EALREADY
        && rc != EALREADY
#endif
    ) {
        if (err)
            *err = rc;
        return NULL;
    }

    spa_t *spa = NULL;
    rc = spa_open(name, &spa, FTAG);
    if (rc != 0) {
        if (imported_offline)
            (void) spa_export(name, NULL, B_TRUE, B_FALSE);
        if (err)
            *err = rc;
        return NULL;
    }

    zdx_pool_t *pool = calloc(1, sizeof (zdx_pool_t));
    if (!pool) {
        spa_close(spa, FTAG);
        if (imported_offline)
            (void) spa_export(name, NULL, B_TRUE, B_FALSE);
        if (err)
            *err = ENOMEM;
        return NULL;
    }

    pool->name = strdup(name);
    if (!pool->name) {
        free(pool);
        spa_close(spa, FTAG);
        if (imported_offline)
            (void) spa_export(name, NULL, B_TRUE, B_FALSE);
        if (err)
            *err = ENOMEM;
        return NULL;
    }

    pool->spa = spa;
    pool->imported_offline = imported_offline;
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

    if (pool->imported_offline && pool->name)
        (void) spa_export(pool->name, NULL, B_TRUE, B_FALSE);

    free(pool->name);
    free(pool);
}
