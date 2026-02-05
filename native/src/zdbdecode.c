#include "../include/zdbdecode.h"
#include "json.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>

/* ZFS headers */
#include <sys/zfs_context.h>
#include <sys/spa.h>
#include <libzpool.h>
#include <libzfs.h>

/* Build-time version info */
#ifndef ZDX_GIT_SHA
#define ZDX_GIT_SHA "unknown"
#endif

/* Opaque pool handle */
struct zdx_pool {
    char *name;
    zpool_handle_t *zpool;
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
 * Stub implementations for M1/M2 functions
 */

zdx_pool_t *
zdx_pool_open(const char *name, int *err)
{
    *err = ENOSYS;
    return NULL;
}

void
zdx_pool_close(zdx_pool_t *pool)
{
    (void)pool;
}

zdx_result_t
zdx_pool_info(zdx_pool_t *pool)
{
    (void)pool;
    return make_error(ENOSYS, "not implemented");
}

zdx_result_t
zdx_pool_vdevs(zdx_pool_t *pool)
{
    (void)pool;
    return make_error(ENOSYS, "not implemented");
}

zdx_result_t
zdx_pool_datasets(zdx_pool_t *pool)
{
    (void)pool;
    return make_error(ENOSYS, "not implemented");
}

zdx_result_t
zdx_mos_list_objects(zdx_pool_t *pool, int type_filter,
                     uint64_t start, uint64_t limit)
{
    (void)pool;
    (void)type_filter;
    (void)start;
    (void)limit;
    return make_error(ENOSYS, "not implemented");
}

zdx_result_t
zdx_mos_get_object(zdx_pool_t *pool, uint64_t objid)
{
    (void)pool;
    (void)objid;
    return make_error(ENOSYS, "not implemented");
}

zdx_result_t
zdx_mos_get_blkptrs(zdx_pool_t *pool, uint64_t objid)
{
    (void)pool;
    (void)objid;
    return make_error(ENOSYS, "not implemented");
}

zdx_result_t
zdx_zap_info(zdx_pool_t *pool, uint64_t objid)
{
    (void)pool;
    (void)objid;
    return make_error(ENOSYS, "not implemented");
}

zdx_result_t
zdx_zap_entries(zdx_pool_t *pool, uint64_t objid,
               uint64_t cursor, uint64_t limit)
{
    (void)pool;
    (void)objid;
    (void)cursor;
    (void)limit;
    return make_error(ENOSYS, "not implemented");
}
