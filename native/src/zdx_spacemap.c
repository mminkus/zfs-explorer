#include "zdbdecode_internal.h"

#define ZDX_SPACEMAP_PAGE_STOP 1
#define ZDX_SPACEMAP_OP_ANY 0
#define ZDX_SPACEMAP_OP_ALLOC 1
#define ZDX_SPACEMAP_OP_FREE 2

typedef struct zdx_spacemap_summary_ctx {
    uint64_t range_entries;
    uint64_t alloc_entries;
    uint64_t free_entries;
    uint64_t alloc_bytes;
    uint64_t free_bytes;
    uint64_t txg_min;
    uint64_t txg_max;
    boolean_t has_txg;
    uint64_t alloc_hist[64];
    uint64_t free_hist[64];
} zdx_spacemap_summary_ctx_t;

typedef struct zdx_spacemap_page_ctx {
    uint64_t cursor;
    uint64_t limit;
    uint64_t seen;
    uint64_t added;
    boolean_t has_more;
    int op_filter;
    uint64_t min_length;
    uint64_t txg_min;
    uint64_t txg_max;
    boolean_t use_txg_min;
    boolean_t use_txg_max;
    char *ranges_json;
    int ranges_count;
} zdx_spacemap_page_ctx_t;

typedef struct zdx_spacemap_bin_accum {
    uint64_t alloc_bytes;
    uint64_t free_bytes;
    uint64_t alloc_ops;
    uint64_t free_ops;
    uint64_t largest_range;
    uint64_t range_bytes_sum;
    uint64_t range_segments;
    uint64_t txg_min;
    uint64_t txg_max;
    boolean_t has_txg;
} zdx_spacemap_bin_accum_t;

typedef struct zdx_spacemap_bins_ctx {
    uint64_t sm_start;
    uint64_t sm_size;
    uint64_t bin_size;
    uint64_t start_bin;
    uint64_t end_bin;
    int op_filter;
    uint64_t min_length;
    uint64_t txg_min;
    uint64_t txg_max;
    boolean_t use_txg_min;
    boolean_t use_txg_max;
    zdx_spacemap_bin_accum_t *bins;
    boolean_t has_more;
} zdx_spacemap_bins_ctx_t;

static uint64_t
zdx_u64_add_sat(uint64_t a, uint64_t b)
{
    if (UINT64_MAX - a < b)
        return UINT64_MAX;
    return a + b;
}

static uint64_t
zdx_u64_mul_sat(uint64_t a, uint64_t b)
{
    if (a == 0 || b == 0)
        return 0;
    if (a > UINT64_MAX / b)
        return UINT64_MAX;
    return a * b;
}

static unsigned
zdx_u64_log2_bucket(uint64_t value)
{
    unsigned bucket = 0;

    if (value == 0)
        return 0;

    while (value > 1) {
        value >>= 1;
        bucket++;
    }
    return bucket;
}

static int
zdx_spacemap_doi(zdx_pool_t *pool, uint64_t objid, dmu_object_info_t *doi_out)
{
    objset_t *mos = NULL;
    dmu_object_info_t doi;
    int err;

    if (!pool || !pool->spa || !doi_out || objid == 0)
        return EINVAL;

    mos = spa_meta_objset(pool->spa);
    if (!mos)
        return EINVAL;

    err = dmu_object_info(mos, objid, &doi);
    if (err != 0)
        return err;

    *doi_out = doi;
    return 0;
}

static int
zdx_open_spacemap(zdx_pool_t *pool, uint64_t objid, space_map_t **sm_out)
{
    objset_t *mos = NULL;
    dmu_object_info_t doi;
    int err;

    if (!pool || !pool->spa || !sm_out || objid == 0)
        return EINVAL;

    mos = spa_meta_objset(pool->spa);
    if (!mos)
        return EINVAL;

    err = dmu_object_info(mos, objid, &doi);
    if (err != 0)
        return err;

    /*
     * A valid space-map object must at least carry the historic v0
     * space_map_phys payload in its bonus buffer.
     */
    if (doi.doi_bonus_size < SPACE_MAP_SIZE_V0)
        return EINVAL;

    err = space_map_open(sm_out, mos, objid, 0, UINT64_MAX,
        SPA_MINBLOCKSHIFT);
    return err;
}

static int
zdx_spacemap_summary_cb(space_map_entry_t *sme, void *arg)
{
    zdx_spacemap_summary_ctx_t *ctx = arg;
    unsigned bucket = 0;

    if (!sme || !ctx)
        return EINVAL;

    bucket = zdx_u64_log2_bucket(sme->sme_run);
    if (bucket > 63)
        bucket = 63;

    ctx->range_entries++;
    if (sme->sme_type == SM_ALLOC) {
        ctx->alloc_entries++;
        ctx->alloc_bytes += sme->sme_run;
        ctx->alloc_hist[bucket]++;
    } else {
        ctx->free_entries++;
        ctx->free_bytes += sme->sme_run;
        ctx->free_hist[bucket]++;
    }

    if (sme->sme_txg != 0) {
        if (!ctx->has_txg) {
            ctx->txg_min = sme->sme_txg;
            ctx->txg_max = sme->sme_txg;
            ctx->has_txg = B_TRUE;
        } else {
            if (sme->sme_txg < ctx->txg_min)
                ctx->txg_min = sme->sme_txg;
            if (sme->sme_txg > ctx->txg_max)
                ctx->txg_max = sme->sme_txg;
        }
    }

    return 0;
}

static int
zdx_spacemap_entry_matches_filter(const space_map_entry_t *sme,
    int op_filter, uint64_t min_length, boolean_t use_txg_min, uint64_t txg_min,
    boolean_t use_txg_max, uint64_t txg_max)
{
    if (!sme)
        return 0;

    if (op_filter == ZDX_SPACEMAP_OP_ALLOC && sme->sme_type != SM_ALLOC)
        return 0;
    if (op_filter == ZDX_SPACEMAP_OP_FREE && sme->sme_type != SM_FREE)
        return 0;
    if (sme->sme_run < min_length)
        return 0;

    if (use_txg_min) {
        if (sme->sme_txg == 0 || sme->sme_txg < txg_min)
            return 0;
    }

    if (use_txg_max) {
        if (sme->sme_txg == 0 || sme->sme_txg > txg_max)
            return 0;
    }

    return 1;
}

static int
zdx_spacemap_page_cb(space_map_entry_t *sme, void *arg)
{
    zdx_spacemap_page_ctx_t *ctx = arg;
    const char *op = NULL;
    char txg_buf[32];
    char sync_buf[32];
    char vdev_buf[32];
    const char *txg_json = "null";
    const char *sync_json = "null";
    const char *vdev_json = "null";
    char *item = NULL;
    char *next = NULL;

    if (!sme || !ctx)
        return EINVAL;

    if (!zdx_spacemap_entry_matches_filter(sme, ctx->op_filter,
        ctx->min_length, ctx->use_txg_min, ctx->txg_min,
        ctx->use_txg_max, ctx->txg_max))
        return 0;

    if (ctx->seen < ctx->cursor) {
        ctx->seen++;
        return 0;
    }

    if (ctx->added >= ctx->limit) {
        ctx->has_more = B_TRUE;
        return ZDX_SPACEMAP_PAGE_STOP;
    }

    op = (sme->sme_type == SM_ALLOC) ? "alloc" : "free";

    if (sme->sme_txg != 0) {
        (void) snprintf(txg_buf, sizeof (txg_buf), "%llu",
            (unsigned long long)sme->sme_txg);
        txg_json = txg_buf;
    }

    if (sme->sme_sync_pass != 0) {
        (void) snprintf(sync_buf, sizeof (sync_buf), "%llu",
            (unsigned long long)sme->sme_sync_pass);
        sync_json = sync_buf;
    }

    if (sme->sme_vdev != SM_NO_VDEVID) {
        (void) snprintf(vdev_buf, sizeof (vdev_buf), "%u", sme->sme_vdev);
        vdev_json = vdev_buf;
    }

    item = json_format(
        "{"
        "\"index\":%llu,"
        "\"op\":\"%s\","
        "\"offset\":%llu,"
        "\"length\":%llu,"
        "\"txg\":%s,"
        "\"sync_pass\":%s,"
        "\"vdev\":%s"
        "}",
        (unsigned long long)ctx->seen,
        op,
        (unsigned long long)sme->sme_offset,
        (unsigned long long)sme->sme_run,
        txg_json,
        sync_json,
        vdev_json);
    if (!item)
        return ENOMEM;

    next = json_array_append(ctx->ranges_json, item);
    free(item);
    if (!next)
        return ENOMEM;

    free(ctx->ranges_json);
    ctx->ranges_json = next;
    ctx->ranges_count++;
    ctx->added++;
    ctx->seen++;
    return 0;
}

static char *
zdx_spacemap_histogram_json(const zdx_spacemap_summary_ctx_t *ctx)
{
    char *array = NULL;
    int count = 0;

    if (!ctx)
        return NULL;

    array = json_array_start();
    if (!array)
        return NULL;

    for (unsigned i = 0; i < 64; i++) {
        uint64_t alloc_count = ctx->alloc_hist[i];
        uint64_t free_count = ctx->free_hist[i];
        uint64_t min_length = (i == 63) ? (1ULL << 63) : (1ULL << i);
        uint64_t max_length = 0;
        char *item = NULL;
        char *next = NULL;

        if (alloc_count == 0 && free_count == 0)
            continue;

        if (i < 63)
            max_length = (1ULL << (i + 1));

        if (i < 63) {
            item = json_format(
                "{"
                "\"bucket\":%u,"
                "\"min_length\":%llu,"
                "\"max_length\":%llu,"
                "\"alloc_count\":%llu,"
                "\"free_count\":%llu"
                "}",
                i,
                (unsigned long long)min_length,
                (unsigned long long)max_length,
                (unsigned long long)alloc_count,
                (unsigned long long)free_count);
        } else {
            item = json_format(
                "{"
                "\"bucket\":%u,"
                "\"min_length\":%llu,"
                "\"max_length\":null,"
                "\"alloc_count\":%llu,"
                "\"free_count\":%llu"
                "}",
                i,
                (unsigned long long)min_length,
                (unsigned long long)alloc_count,
                (unsigned long long)free_count);
        }

        if (!item) {
            free(array);
            return NULL;
        }

        next = json_array_append(array, item);
        free(item);
        if (!next) {
            free(array);
            return NULL;
        }

        free(array);
        array = next;
        count++;
    }

    {
        char *final_json = json_array_end(array, count > 0);
        free(array);
        return final_json;
    }
}

zdx_result_t
zdx_spacemap_summary(zdx_pool_t *pool, uint64_t objid)
{
    space_map_t *sm = NULL;
    dmu_object_info_t doi;
    zdx_spacemap_summary_ctx_t ctx = {0};
    char *hist_json = NULL;
    char *result = NULL;
    char txg_min_buf[32];
    char txg_max_buf[32];
    char net_bytes_buf[32];
    const char *txg_min_json = "null";
    const char *txg_max_json = "null";
    int64_t net_bytes = 0;
    int err;

    err = zdx_spacemap_doi(pool, objid, &doi);
    if (err != 0) {
        return make_error(err, "failed to inspect spacemap object %llu: %s",
            (unsigned long long)objid, strerror(err));
    }

    if (doi.doi_type != DMU_OT_SPACE_MAP) {
        return make_error(EINVAL,
            "object %llu is type \"%s\" (%u); expected \"space map\"",
            (unsigned long long)objid,
            dmu_ot_name_safe(doi.doi_type),
            doi.doi_type);
    }

    if (doi.doi_bonus_size < SPACE_MAP_SIZE_V0) {
        return make_error(EINVAL,
            "object %llu bonus is too small for space map payload "
            "(bonus=%u, need>=%u)",
            (unsigned long long)objid,
            doi.doi_bonus_size,
            SPACE_MAP_SIZE_V0);
    }

    err = zdx_open_spacemap(pool, objid, &sm);
    if (err != 0)
        return make_error(err, "failed to open spacemap object %llu: %s",
            (unsigned long long)objid, strerror(err));

    err = space_map_iterate(sm, space_map_length(sm), zdx_spacemap_summary_cb,
        &ctx);
    if (err != 0) {
        space_map_close(sm);
        return make_error(err, "failed to iterate spacemap object %llu",
            (unsigned long long)objid);
    }

    hist_json = zdx_spacemap_histogram_json(&ctx);
    if (!hist_json) {
        space_map_close(sm);
        return make_error(ENOMEM, "failed to encode spacemap histogram");
    }

    if (ctx.has_txg) {
        (void) snprintf(txg_min_buf, sizeof (txg_min_buf), "%llu",
            (unsigned long long)ctx.txg_min);
        (void) snprintf(txg_max_buf, sizeof (txg_max_buf), "%llu",
            (unsigned long long)ctx.txg_max);
        txg_min_json = txg_min_buf;
        txg_max_json = txg_max_buf;
    }

    if (ctx.alloc_bytes >= ctx.free_bytes) {
        net_bytes = (int64_t)(ctx.alloc_bytes - ctx.free_bytes);
        (void) snprintf(net_bytes_buf, sizeof (net_bytes_buf), "%lld",
            (long long)net_bytes);
    } else {
        net_bytes = -(int64_t)(ctx.free_bytes - ctx.alloc_bytes);
        (void) snprintf(net_bytes_buf, sizeof (net_bytes_buf), "%lld",
            (long long)net_bytes);
    }

    result = json_format(
        "{"
        "\"object\":%llu,"
        "\"start\":%llu,"
        "\"size\":%llu,"
        "\"shift\":%u,"
        "\"length\":%llu,"
        "\"allocated\":%lld,"
        "\"smp_length\":%llu,"
        "\"smp_alloc\":%lld,"
        "\"range_entries\":%llu,"
        "\"alloc_entries\":%llu,"
        "\"free_entries\":%llu,"
        "\"alloc_bytes\":%llu,"
        "\"free_bytes\":%llu,"
        "\"net_bytes\":%s,"
        "\"txg_min\":%s,"
        "\"txg_max\":%s,"
        "\"histogram\":%s"
        "}",
        (unsigned long long)objid,
        (unsigned long long)sm->sm_start,
        (unsigned long long)sm->sm_size,
        sm->sm_shift,
        (unsigned long long)space_map_length(sm),
        (long long)space_map_allocated(sm),
        (unsigned long long)sm->sm_phys->smp_length,
        (long long)sm->sm_phys->smp_alloc,
        (unsigned long long)ctx.range_entries,
        (unsigned long long)ctx.alloc_entries,
        (unsigned long long)ctx.free_entries,
        (unsigned long long)ctx.alloc_bytes,
        (unsigned long long)ctx.free_bytes,
        net_bytes_buf,
        txg_min_json,
        txg_max_json,
        hist_json);

    free(hist_json);
    space_map_close(sm);

    if (!result)
        return make_error(ENOMEM, "failed to encode spacemap summary");
    return make_success(result);
}

zdx_result_t
zdx_spacemap_ranges(zdx_pool_t *pool, uint64_t objid, uint64_t cursor,
    uint64_t limit, int op_filter, uint64_t min_length, uint64_t txg_min,
    uint64_t txg_max)
{
    space_map_t *sm = NULL;
    dmu_object_info_t doi;
    zdx_spacemap_page_ctx_t page = {0};
    char *ranges_final = NULL;
    char *result = NULL;
    char next_buf[32];
    char txg_min_buf[32];
    char txg_max_buf[32];
    const char *next_json = "null";
    const char *txg_min_json = "null";
    const char *txg_max_json = "null";
    const char *op_filter_json = "all";
    int err;

    if (limit == 0)
        limit = 200;
    if (limit > 2000)
        limit = 2000;

    if (op_filter != ZDX_SPACEMAP_OP_ANY &&
        op_filter != ZDX_SPACEMAP_OP_ALLOC &&
        op_filter != ZDX_SPACEMAP_OP_FREE) {
        return make_error(EINVAL, "invalid spacemap op_filter=%d", op_filter);
    }

    if (op_filter == ZDX_SPACEMAP_OP_ALLOC)
        op_filter_json = "alloc";
    else if (op_filter == ZDX_SPACEMAP_OP_FREE)
        op_filter_json = "free";

    if (txg_min != 0 && txg_max != 0 && txg_min > txg_max) {
        return make_error(EINVAL,
            "txg_min (%llu) must be <= txg_max (%llu)",
            (unsigned long long)txg_min, (unsigned long long)txg_max);
    }

    err = zdx_spacemap_doi(pool, objid, &doi);
    if (err != 0) {
        return make_error(err, "failed to inspect spacemap object %llu: %s",
            (unsigned long long)objid, strerror(err));
    }

    if (doi.doi_type != DMU_OT_SPACE_MAP) {
        return make_error(EINVAL,
            "object %llu is type \"%s\" (%u); expected \"space map\"",
            (unsigned long long)objid,
            dmu_ot_name_safe(doi.doi_type),
            doi.doi_type);
    }

    if (doi.doi_bonus_size < SPACE_MAP_SIZE_V0) {
        return make_error(EINVAL,
            "object %llu bonus is too small for space map payload "
            "(bonus=%u, need>=%u)",
            (unsigned long long)objid,
            doi.doi_bonus_size,
            SPACE_MAP_SIZE_V0);
    }

    err = zdx_open_spacemap(pool, objid, &sm);
    if (err != 0)
        return make_error(err, "failed to open spacemap object %llu: %s",
            (unsigned long long)objid, strerror(err));

    page.cursor = cursor;
    page.limit = limit;
    page.op_filter = op_filter;
    page.min_length = min_length;
    page.txg_min = txg_min;
    page.txg_max = txg_max;
    page.use_txg_min = (txg_min != 0) ? B_TRUE : B_FALSE;
    page.use_txg_max = (txg_max != 0) ? B_TRUE : B_FALSE;
    page.ranges_json = json_array_start();
    if (!page.ranges_json) {
        space_map_close(sm);
        return make_error(ENOMEM, "failed to allocate ranges JSON");
    }

    err = space_map_iterate(sm, space_map_length(sm), zdx_spacemap_page_cb,
        &page);
    if (err != 0 && err != ZDX_SPACEMAP_PAGE_STOP) {
        free(page.ranges_json);
        space_map_close(sm);
        return make_error(err, "failed to iterate spacemap object %llu",
            (unsigned long long)objid);
    }

    ranges_final = json_array_end(page.ranges_json, page.ranges_count > 0);
    free(page.ranges_json);
    if (!ranges_final) {
        space_map_close(sm);
        return make_error(ENOMEM, "failed to finalize ranges JSON");
    }

    if (page.has_more) {
        (void) snprintf(next_buf, sizeof (next_buf), "%llu",
            (unsigned long long)(cursor + page.added));
        next_json = next_buf;
    }

    if (page.use_txg_min) {
        (void) snprintf(txg_min_buf, sizeof (txg_min_buf), "%llu",
            (unsigned long long)txg_min);
        txg_min_json = txg_min_buf;
    }
    if (page.use_txg_max) {
        (void) snprintf(txg_max_buf, sizeof (txg_max_buf), "%llu",
            (unsigned long long)txg_max);
        txg_max_json = txg_max_buf;
    }

    result = json_format(
        "{"
        "\"object\":%llu,"
        "\"start\":%llu,"
        "\"size\":%llu,"
        "\"shift\":%u,"
        "\"cursor\":%llu,"
        "\"limit\":%llu,"
        "\"count\":%llu,"
        "\"next\":%s,"
        "\"filters\":{"
        "\"op\":\"%s\","
        "\"min_length\":%llu,"
        "\"txg_min\":%s,"
        "\"txg_max\":%s"
        "},"
        "\"ranges\":%s"
        "}",
        (unsigned long long)objid,
        (unsigned long long)sm->sm_start,
        (unsigned long long)sm->sm_size,
        sm->sm_shift,
        (unsigned long long)cursor,
        (unsigned long long)limit,
        (unsigned long long)page.added,
        next_json,
        op_filter_json,
        (unsigned long long)min_length,
        txg_min_json,
        txg_max_json,
        ranges_final);

    free(ranges_final);
    space_map_close(sm);

    if (!result)
        return make_error(ENOMEM, "failed to encode spacemap ranges");
    return make_success(result);
}

static int
zdx_spacemap_bins_cb(space_map_entry_t *sme, void *arg)
{
    zdx_spacemap_bins_ctx_t *ctx = arg;
    uint64_t abs_start = 0;
    uint64_t abs_end = 0;
    uint64_t rel_start = 0;
    uint64_t rel_end = 0;
    uint64_t first_bin = 0;
    uint64_t last_bin = 0;
    uint64_t bin_lo = 0;
    uint64_t bin_hi = 0;

    if (!sme || !ctx)
        return EINVAL;

    if (!zdx_spacemap_entry_matches_filter(sme, ctx->op_filter,
        ctx->min_length, ctx->use_txg_min, ctx->txg_min,
        ctx->use_txg_max, ctx->txg_max))
        return 0;

    abs_start = sme->sme_offset;
    abs_end = zdx_u64_add_sat(sme->sme_offset, sme->sme_run);
    if (abs_end <= ctx->sm_start)
        return 0;

    if (abs_start < ctx->sm_start)
        abs_start = ctx->sm_start;
    if (abs_end < ctx->sm_start)
        abs_end = ctx->sm_start;

    rel_start = abs_start - ctx->sm_start;
    rel_end = abs_end - ctx->sm_start;
    if (rel_end <= rel_start)
        return 0;

    first_bin = rel_start / ctx->bin_size;
    last_bin = (rel_end - 1) / ctx->bin_size;

    if (first_bin >= ctx->end_bin) {
        ctx->has_more = B_TRUE;
        return 0;
    }
    if (last_bin < ctx->start_bin)
        return 0;

    bin_lo = (first_bin > ctx->start_bin) ? first_bin : ctx->start_bin;
    bin_hi = (last_bin < (ctx->end_bin - 1)) ? last_bin : (ctx->end_bin - 1);

    for (uint64_t bin = bin_lo; bin <= bin_hi; bin++) {
        uint64_t idx = bin - ctx->start_bin;
        uint64_t bin_rel_start = zdx_u64_mul_sat(bin, ctx->bin_size);
        uint64_t bin_rel_end = zdx_u64_add_sat(bin_rel_start, ctx->bin_size);
        uint64_t overlap_start = (rel_start > bin_rel_start) ?
            rel_start : bin_rel_start;
        uint64_t overlap_end = (rel_end < bin_rel_end) ? rel_end : bin_rel_end;
        uint64_t seg_len = 0;
        zdx_spacemap_bin_accum_t *acc = NULL;

        if (overlap_end <= overlap_start)
            continue;

        seg_len = overlap_end - overlap_start;
        if (idx >= (ctx->end_bin - ctx->start_bin))
            continue;

        acc = &ctx->bins[idx];
        if (sme->sme_type == SM_ALLOC) {
            acc->alloc_bytes += seg_len;
            acc->alloc_ops++;
        } else {
            acc->free_bytes += seg_len;
            acc->free_ops++;
        }

        if (seg_len > acc->largest_range)
            acc->largest_range = seg_len;
        acc->range_bytes_sum += seg_len;
        acc->range_segments++;

        if (sme->sme_txg != 0) {
            if (!acc->has_txg) {
                acc->txg_min = sme->sme_txg;
                acc->txg_max = sme->sme_txg;
                acc->has_txg = B_TRUE;
            } else {
                if (sme->sme_txg < acc->txg_min)
                    acc->txg_min = sme->sme_txg;
                if (sme->sme_txg > acc->txg_max)
                    acc->txg_max = sme->sme_txg;
            }
        }
    }

    return 0;
}

zdx_result_t
zdx_spacemap_bins(zdx_pool_t *pool, uint64_t objid, uint64_t bin_size,
    uint64_t cursor, uint64_t limit, int op_filter, uint64_t min_length,
    uint64_t txg_min, uint64_t txg_max)
{
    space_map_t *sm = NULL;
    dmu_object_info_t doi;
    zdx_spacemap_bins_ctx_t bins = {0};
    zdx_spacemap_bin_accum_t *accum = NULL;
    char *bins_json = NULL;
    char *bins_final = NULL;
    char *result = NULL;
    uint64_t page_bins = 0;
    uint64_t total_bins = 0;
    boolean_t total_known = B_TRUE;
    uint64_t next_cursor = 0;
    boolean_t has_next = B_FALSE;
    char next_buf[32];
    char total_bins_buf[32];
    char txg_min_buf[32];
    char txg_max_buf[32];
    const char *next_json = "null";
    const char *total_bins_json = "null";
    const char *txg_min_json = "null";
    const char *txg_max_json = "null";
    const char *op_filter_json = "all";
    int bins_count = 0;
    int err;

    if (bin_size == 0)
        bin_size = 1ULL << 20;
    if (bin_size < 512)
        bin_size = 512;
    if (limit == 0)
        limit = 256;
    if (limit > 2048)
        limit = 2048;

    if (op_filter != ZDX_SPACEMAP_OP_ANY &&
        op_filter != ZDX_SPACEMAP_OP_ALLOC &&
        op_filter != ZDX_SPACEMAP_OP_FREE) {
        return make_error(EINVAL, "invalid spacemap op_filter=%d", op_filter);
    }

    if (op_filter == ZDX_SPACEMAP_OP_ALLOC)
        op_filter_json = "alloc";
    else if (op_filter == ZDX_SPACEMAP_OP_FREE)
        op_filter_json = "free";

    if (txg_min != 0 && txg_max != 0 && txg_min > txg_max) {
        return make_error(EINVAL,
            "txg_min (%llu) must be <= txg_max (%llu)",
            (unsigned long long)txg_min, (unsigned long long)txg_max);
    }

    err = zdx_spacemap_doi(pool, objid, &doi);
    if (err != 0) {
        return make_error(err, "failed to inspect spacemap object %llu: %s",
            (unsigned long long)objid, strerror(err));
    }

    if (doi.doi_type != DMU_OT_SPACE_MAP) {
        return make_error(EINVAL,
            "object %llu is type \"%s\" (%u); expected \"space map\"",
            (unsigned long long)objid,
            dmu_ot_name_safe(doi.doi_type),
            doi.doi_type);
    }

    if (doi.doi_bonus_size < SPACE_MAP_SIZE_V0) {
        return make_error(EINVAL,
            "object %llu bonus is too small for space map payload "
            "(bonus=%u, need>=%u)",
            (unsigned long long)objid,
            doi.doi_bonus_size,
            SPACE_MAP_SIZE_V0);
    }

    err = zdx_open_spacemap(pool, objid, &sm);
    if (err != 0)
        return make_error(err, "failed to open spacemap object %llu: %s",
            (unsigned long long)objid, strerror(err));

    if (sm->sm_size == UINT64_MAX) {
        total_known = B_FALSE;
    } else {
        total_bins = sm->sm_size / bin_size;
        if ((sm->sm_size % bin_size) != 0)
            total_bins++;
        if (total_bins == 0)
            total_bins = 1;
    }

    if (total_known) {
        if (cursor >= total_bins) {
            page_bins = 0;
        } else {
            page_bins = total_bins - cursor;
            if (page_bins > limit)
                page_bins = limit;
        }
    } else {
        page_bins = limit;
    }

    bins_json = json_array_start();
    if (!bins_json) {
        space_map_close(sm);
        return make_error(ENOMEM, "failed to allocate bins JSON");
    }

    if (page_bins > 0) {
        accum = calloc(page_bins, sizeof (zdx_spacemap_bin_accum_t));
        if (!accum) {
            free(bins_json);
            space_map_close(sm);
            return make_error(ENOMEM, "failed to allocate bins state");
        }

        bins.sm_start = sm->sm_start;
        bins.sm_size = sm->sm_size;
        bins.bin_size = bin_size;
        bins.start_bin = cursor;
        bins.end_bin = zdx_u64_add_sat(cursor, page_bins);
        bins.op_filter = op_filter;
        bins.min_length = min_length;
        bins.txg_min = txg_min;
        bins.txg_max = txg_max;
        bins.use_txg_min = (txg_min != 0) ? B_TRUE : B_FALSE;
        bins.use_txg_max = (txg_max != 0) ? B_TRUE : B_FALSE;
        bins.bins = accum;

        err = space_map_iterate(sm, space_map_length(sm), zdx_spacemap_bins_cb,
            &bins);
        if (err != 0) {
            free(accum);
            free(bins_json);
            space_map_close(sm);
            return make_error(err, "failed to iterate spacemap object %llu",
                (unsigned long long)objid);
        }
    }

    for (uint64_t i = 0; i < page_bins; i++) {
        uint64_t bin_index = cursor + i;
        uint64_t rel_start = zdx_u64_mul_sat(bin_index, bin_size);
        uint64_t abs_start = zdx_u64_add_sat(sm->sm_start, rel_start);
        uint64_t abs_end = zdx_u64_add_sat(abs_start, bin_size - 1);
        zdx_spacemap_bin_accum_t *acc = &accum[i];
        uint64_t ops_total = acc->alloc_ops + acc->free_ops;
        uint64_t avg_range = (acc->range_segments == 0) ? 0 :
            (acc->range_bytes_sum / acc->range_segments);
        char txg_min_local_buf[32];
        char txg_max_local_buf[32];
        char net_bytes_buf[32];
        const char *bin_txg_min_json = "null";
        const char *bin_txg_max_json = "null";
        char *item = NULL;
        char *next = NULL;

        if (acc->has_txg) {
            (void) snprintf(txg_min_local_buf, sizeof (txg_min_local_buf), "%llu",
                (unsigned long long)acc->txg_min);
            (void) snprintf(txg_max_local_buf, sizeof (txg_max_local_buf), "%llu",
                (unsigned long long)acc->txg_max);
            bin_txg_min_json = txg_min_local_buf;
            bin_txg_max_json = txg_max_local_buf;
        }

        if (acc->alloc_bytes >= acc->free_bytes) {
            (void) snprintf(net_bytes_buf, sizeof (net_bytes_buf), "%lld",
                (long long)(acc->alloc_bytes - acc->free_bytes));
        } else {
            (void) snprintf(net_bytes_buf, sizeof (net_bytes_buf), "%lld",
                -(long long)(acc->free_bytes - acc->alloc_bytes));
        }

        item = json_format(
            "{"
            "\"index\":%llu,"
            "\"offset_start\":%llu,"
            "\"offset_end\":%llu,"
            "\"alloc_bytes\":%llu,"
            "\"free_bytes\":%llu,"
            "\"net_bytes\":%s,"
            "\"alloc_ops\":%llu,"
            "\"free_ops\":%llu,"
            "\"ops_total\":%llu,"
            "\"txg_min\":%s,"
            "\"txg_max\":%s,"
            "\"largest_range\":%llu,"
            "\"avg_range\":%llu"
            "}",
            (unsigned long long)bin_index,
            (unsigned long long)abs_start,
            (unsigned long long)abs_end,
            (unsigned long long)acc->alloc_bytes,
            (unsigned long long)acc->free_bytes,
            net_bytes_buf,
            (unsigned long long)acc->alloc_ops,
            (unsigned long long)acc->free_ops,
            (unsigned long long)ops_total,
            bin_txg_min_json,
            bin_txg_max_json,
            (unsigned long long)acc->largest_range,
            (unsigned long long)avg_range);
        if (!item) {
            free(accum);
            free(bins_json);
            space_map_close(sm);
            return make_error(ENOMEM, "failed to encode bins row");
        }

        next = json_array_append(bins_json, item);
        free(item);
        if (!next) {
            free(accum);
            free(bins_json);
            space_map_close(sm);
            return make_error(ENOMEM, "failed to append bins row");
        }

        free(bins_json);
        bins_json = next;
        bins_count++;
    }

    bins_final = json_array_end(bins_json, bins_count > 0);
    free(bins_json);
    if (!bins_final) {
        free(accum);
        space_map_close(sm);
        return make_error(ENOMEM, "failed to finalize bins JSON");
    }

    if (total_known) {
        (void) snprintf(total_bins_buf, sizeof (total_bins_buf), "%llu",
            (unsigned long long)total_bins);
        total_bins_json = total_bins_buf;

        if ((cursor < total_bins) && (page_bins > 0) &&
            (cursor + page_bins < total_bins)) {
            has_next = B_TRUE;
            next_cursor = cursor + page_bins;
        }
    } else if (bins.has_more && page_bins > 0) {
        has_next = B_TRUE;
        next_cursor = cursor + page_bins;
    }

    if (has_next) {
        (void) snprintf(next_buf, sizeof (next_buf), "%llu",
            (unsigned long long)next_cursor);
        next_json = next_buf;
    }

    if (txg_min != 0) {
        (void) snprintf(txg_min_buf, sizeof (txg_min_buf), "%llu",
            (unsigned long long)txg_min);
        txg_min_json = txg_min_buf;
    }
    if (txg_max != 0) {
        (void) snprintf(txg_max_buf, sizeof (txg_max_buf), "%llu",
            (unsigned long long)txg_max);
        txg_max_json = txg_max_buf;
    }

    result = json_format(
        "{"
        "\"object\":%llu,"
        "\"start\":%llu,"
        "\"size\":%llu,"
        "\"shift\":%u,"
        "\"bin_size\":%llu,"
        "\"cursor\":%llu,"
        "\"limit\":%llu,"
        "\"count\":%llu,"
        "\"next\":%s,"
        "\"total_bins\":%s,"
        "\"filters\":{"
        "\"op\":\"%s\","
        "\"min_length\":%llu,"
        "\"txg_min\":%s,"
        "\"txg_max\":%s"
        "},"
        "\"bins\":%s"
        "}",
        (unsigned long long)objid,
        (unsigned long long)sm->sm_start,
        (unsigned long long)sm->sm_size,
        sm->sm_shift,
        (unsigned long long)bin_size,
        (unsigned long long)cursor,
        (unsigned long long)limit,
        (unsigned long long)page_bins,
        next_json,
        total_bins_json,
        op_filter_json,
        (unsigned long long)min_length,
        txg_min_json,
        txg_max_json,
        bins_final);

    free(accum);
    free(bins_final);
    space_map_close(sm);

    if (!result)
        return make_error(ENOMEM, "failed to encode spacemap bins");
    return make_success(result);
}
