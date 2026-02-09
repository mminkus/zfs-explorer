#include "zdbdecode_internal.h"

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
