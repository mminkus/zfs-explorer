#include "zdbdecode_internal.h"

/*
 * Read a raw block by vdev + offset.
 */
zdx_result_t
zdx_read_block(zdx_pool_t *pool, uint64_t vdev_id,
    uint64_t offset, uint64_t size)
{
    if (!pool || !pool->spa)
        return make_error(EINVAL, "pool not open");

    if (size == 0)
        return make_error(EINVAL, "size must be > 0");

    const uint64_t max_read = 1ULL << 20; /* 1 MiB safety cap */
    if (size > max_read)
        return make_error(EINVAL, "size too large (max %llu bytes)",
            (unsigned long long)max_read);

    spa_t *spa = pool->spa;
    spa_config_enter(spa, SCL_VDEV, FTAG, RW_READER);
    vdev_t *vd = vdev_lookup_top(spa, vdev_id);
    spa_config_exit(spa, SCL_VDEV, FTAG);

    if (!vd)
        return make_error(ENOENT, "vdev %llu not found",
            (unsigned long long)vdev_id);

    if (!vdev_readable(vd))
        return make_error(EIO, "vdev %llu not readable",
            (unsigned long long)vdev_id);

    abd_t *abd = abd_alloc(size, B_FALSE);
    if (!abd)
        return make_error(ENOMEM, "failed to allocate abd");

    blkptr_t bp;
    dva_t *dva = &bp.blk_dva[0];
    BP_ZERO(&bp);

    DVA_SET_VDEV(&dva[0], vdev_id);
    DVA_SET_OFFSET(&dva[0], offset);
    DVA_SET_GANG(&dva[0], 0);
    DVA_SET_ASIZE(&dva[0], size);

    BP_SET_BIRTH(&bp, TXG_INITIAL, TXG_INITIAL);
    BP_SET_LSIZE(&bp, size);
    BP_SET_PSIZE(&bp, size);
    BP_SET_COMPRESS(&bp, ZIO_COMPRESS_OFF);
    BP_SET_CHECKSUM(&bp, ZIO_CHECKSUM_OFF);
    BP_SET_TYPE(&bp, DMU_OT_NONE);
    BP_SET_LEVEL(&bp, 0);
    BP_SET_DEDUP(&bp, 0);
    BP_SET_BYTEORDER(&bp, ZFS_HOST_BYTEORDER);

    spa_config_enter(spa, SCL_STATE, FTAG, RW_READER);
    zio_t *zio = zio_root(spa, NULL, NULL, ZIO_FLAG_CANFAIL);
    if (!zio) {
        spa_config_exit(spa, SCL_STATE, FTAG);
        abd_free(abd);
        return make_error(ENOMEM, "failed to create zio root");
    }

    zio_nowait(zio_read(zio, spa, &bp, abd, size,
        NULL, NULL, ZIO_PRIORITY_SYNC_READ,
        ZIO_FLAG_CANFAIL | ZIO_FLAG_RAW, NULL));

    int err = zio_wait(zio);
    spa_config_exit(spa, SCL_STATE, FTAG);
    if (err != 0) {
        abd_free(abd);
        return make_error(err, "zio_read failed: %s", strerror(err));
    }

    void *buf = abd_borrow_buf_copy(abd, size);
    if (!buf) {
        abd_free(abd);
        return make_error(ENOMEM, "failed to borrow abd buffer");
    }

    char *hex = bytes_to_hex((const uint8_t *)buf, (size_t)size);
    abd_return_buf_copy(abd, buf, size);
    abd_free(abd);
    if (!hex)
        return make_error(ENOMEM, "failed to encode hex");

    char *hex_json = json_string(hex);
    free(hex);
    if (!hex_json)
        return make_error(ENOMEM, "failed to allocate JSON string");

    char *result = json_format(
        "{"
        "\"vdev\":%llu,"
        "\"offset\":%llu,"
        "\"size\":%llu,"
        "\"data_hex\":%s"
        "}",
        (unsigned long long)vdev_id,
        (unsigned long long)offset,
        (unsigned long long)size,
        hex_json);
    free(hex_json);

    if (!result)
        return make_error(ENOMEM, "failed to allocate JSON result");

    return make_success(result);
}
