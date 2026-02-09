#include "zdbdecode_internal.h"

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
