#include "zdbdecode_internal.h"
#include <sys/dbuf.h>

typedef struct zdx_block_tree_ctx {
    char *nodes;
    int count;
    uint64_t next_id;
    uint64_t max_depth;
    uint64_t max_nodes;
    boolean_t truncated;
} zdx_block_tree_ctx_t;

static int
zdx_block_tree_append_node(zdx_block_tree_ctx_t *ctx, char *item)
{
    char *new_nodes = json_array_append(ctx->nodes, item);
    if (new_nodes == NULL)
        return (ENOMEM);

    free(ctx->nodes);
    ctx->nodes = new_nodes;
    ctx->count++;
    return (0);
}

static char *
zdx_block_tree_dvas_json(const blkptr_t *bp)
{
    char *dvas = json_array_start();
    if (dvas == NULL)
        return (NULL);

    int dva_count = 0;
    for (int i = 0; i < SPA_DVAS_PER_BP; i++) {
        const dva_t *dva = &bp->blk_dva[i];
        if (!DVA_IS_VALID(dva))
            continue;

        char *item = json_format(
            "{"
            "\"vdev\":%llu,"
            "\"offset\":%llu,"
            "\"asize\":%llu,"
            "\"is_gang\":%s"
            "}",
            (unsigned long long)DVA_GET_VDEV(dva),
            (unsigned long long)DVA_GET_OFFSET(dva),
            (unsigned long long)DVA_GET_ASIZE(dva),
            DVA_GET_GANG(dva) ? "true" : "false");
        if (item == NULL) {
            free(dvas);
            return (NULL);
        }

        char *new_dvas = json_array_append(dvas, item);
        free(item);
        if (new_dvas == NULL) {
            free(dvas);
            return (NULL);
        }

        free(dvas);
        dvas = new_dvas;
        dva_count++;
    }

    char *dvas_json = json_array_end(dvas, dva_count > 0);
    free(dvas);
    return (dvas_json);
}

static int
zdx_block_tree_append_bp(zdx_block_tree_ctx_t *ctx, dnode_t *dn,
    const blkptr_t *bp, uint64_t blkid, int64_t parent_id, int edge_index,
    int is_spill, uint64_t depth)
{
    if (ctx->count >= (int)ctx->max_nodes) {
        ctx->truncated = B_TRUE;
        return (0);
    }

    uint64_t node_id = ctx->next_id++;
    int level = BP_GET_LEVEL(bp);
    int child_slots = level > 0 ? EPB(dn->dn_indblkshift, SPA_BLKPTRSHIFT) : 0;
    boolean_t can_descend = !BP_IS_HOLE(bp) && !BP_IS_EMBEDDED(bp) &&
        level > 0 && depth < ctx->max_depth && !is_spill;

    char parent_buf[32];
    const char *parent_json;
    if (parent_id < 0) {
        parent_json = "null";
    } else {
        (void)snprintf(parent_buf, sizeof (parent_buf), "%lld",
            (long long)parent_id);
        parent_json = parent_buf;
    }

    char *dvas_json = zdx_block_tree_dvas_json(bp);
    if (dvas_json == NULL)
        return (ENOMEM);

    char *item = json_format(
        "{"
        "\"id\":%llu,"
        "\"kind\":\"blkptr\","
        "\"parent_id\":%s,"
        "\"edge_index\":%d,"
        "\"is_spill\":%s,"
        "\"blkid\":%llu,"
        "\"level\":%d,"
        "\"type\":%d,"
        "\"lsize\":%llu,"
        "\"psize\":%llu,"
        "\"asize\":%llu,"
        "\"birth_txg\":%llu,"
        "\"logical_birth\":%llu,"
        "\"physical_birth\":%llu,"
        "\"fill\":%llu,"
        "\"checksum\":%d,"
        "\"compression\":%d,"
        "\"dedup\":%s,"
        "\"ndvas\":%d,"
        "\"is_hole\":%s,"
        "\"is_embedded\":%s,"
        "\"is_gang\":%s,"
        "\"child_slots\":%d,"
        "\"dvas\":%s"
        "}",
        (unsigned long long)node_id,
        parent_json,
        edge_index,
        is_spill ? "true" : "false",
        (unsigned long long)blkid,
        level,
        BP_GET_TYPE(bp),
        (unsigned long long)BP_GET_LSIZE(bp),
        (unsigned long long)BP_GET_PSIZE(bp),
        (unsigned long long)BP_GET_ASIZE(bp),
        (unsigned long long)BP_GET_BIRTH(bp),
        (unsigned long long)BP_GET_LOGICAL_BIRTH(bp),
        (unsigned long long)BP_GET_PHYSICAL_BIRTH(bp),
        (unsigned long long)BP_GET_FILL(bp),
        BP_GET_CHECKSUM(bp),
        BP_GET_COMPRESS(bp),
        BP_GET_DEDUP(bp) ? "true" : "false",
        BP_GET_NDVAS(bp),
        BP_IS_HOLE(bp) ? "true" : "false",
        BP_IS_EMBEDDED(bp) ? "true" : "false",
        BP_IS_GANG(bp) ? "true" : "false",
        child_slots,
        dvas_json);
    free(dvas_json);
    if (item == NULL)
        return (ENOMEM);

    int err = zdx_block_tree_append_node(ctx, item);
    free(item);
    if (err != 0)
        return (err);

    if (!can_descend)
        return (0);

    for (int i = 0; i < child_slots; i++) {
        if (ctx->count >= (int)ctx->max_nodes) {
            ctx->truncated = B_TRUE;
            break;
        }

        uint64_t child_blkid = blkid * (uint64_t)child_slots + (uint64_t)i;
        blkptr_t child_bp;
        uint16_t datablkszsec = 0;
        uint8_t indblkshift = 0;
        err = dbuf_dnode_findbp(dn, (uint64_t)(level - 1), child_blkid,
            &child_bp, &datablkszsec, &indblkshift);
        if (err != 0)
            continue;

        err = zdx_block_tree_append_bp(ctx, dn, &child_bp, child_blkid,
            (int64_t)node_id, i, 0, depth + 1);
        if (err != 0)
            return (err);
    }

    return (0);
}

static zdx_result_t
zdx_block_tree_from_dnode(const char *scope, uint64_t objset_id,
    boolean_t has_objset_id, uint64_t objid, dnode_t *dn, uint64_t max_depth,
    uint64_t max_nodes)
{
    if (dn == NULL || dn->dn_phys == NULL)
        return make_error(EINVAL, "missing dnode");

    zdx_block_tree_ctx_t ctx = {
        .nodes = json_array_start(),
        .count = 0,
        .next_id = 1,
        .max_depth = max_depth,
        .max_nodes = max_nodes,
        .truncated = B_FALSE,
    };
    if (ctx.nodes == NULL)
        return make_error(ENOMEM, "failed to allocate JSON array");

    /*
     * dbuf_dnode_findbp() asserts that dn_struct_rwlock is held.
     * Hold this lock in reader mode for the full traversal.
     */
    rw_enter(&dn->dn_struct_rwlock, RW_READER);

    dnode_phys_t *dnp = dn->dn_phys;
    char *root_item = json_format(
        "{"
        "\"id\":0,"
        "\"kind\":\"dnode\","
        "\"parent_id\":null,"
        "\"edge_index\":null,"
        "\"object\":%llu,"
        "\"nlevels\":%u,"
        "\"nblkptr\":%u,"
        "\"indblkshift\":%u,"
        "\"datablksz\":%u,"
        "\"maxblkid\":%llu,"
        "\"has_spill\":%s"
        "}",
        (unsigned long long)objid,
        (unsigned)dn->dn_nlevels,
        (unsigned)dnp->dn_nblkptr,
        (unsigned)dn->dn_indblkshift,
        (unsigned)dn->dn_datablksz,
        (unsigned long long)dnp->dn_maxblkid,
        (dnp->dn_flags & DNODE_FLAG_SPILL_BLKPTR) ? "true" : "false");
    if (root_item == NULL) {
        rw_exit(&dn->dn_struct_rwlock);
        free(ctx.nodes);
        return make_error(ENOMEM, "failed to allocate root JSON");
    }

    int err = zdx_block_tree_append_node(&ctx, root_item);
    free(root_item);
    if (err != 0) {
        rw_exit(&dn->dn_struct_rwlock);
        free(ctx.nodes);
        return make_error(err, "failed to append root node");
    }

    for (int i = 0; i < dnp->dn_nblkptr; i++) {
        err = zdx_block_tree_append_bp(&ctx, dn, &dnp->dn_blkptr[i], i, 0, i, 0, 0);
        if (err != 0) {
            rw_exit(&dn->dn_struct_rwlock);
            free(ctx.nodes);
            return make_error(err, "failed to append block-tree node");
        }
    }

    if ((dnp->dn_flags & DNODE_FLAG_SPILL_BLKPTR) != 0 &&
        ctx.count < (int)ctx.max_nodes) {
        err = zdx_block_tree_append_bp(&ctx, dn, DN_SPILL_BLKPTR(dnp),
            0, 0, dnp->dn_nblkptr, 1, 0);
        if (err != 0) {
            rw_exit(&dn->dn_struct_rwlock);
            free(ctx.nodes);
            return make_error(err, "failed to append spill block-tree node");
        }
    } else if ((dnp->dn_flags & DNODE_FLAG_SPILL_BLKPTR) != 0) {
        ctx.truncated = B_TRUE;
    }

    rw_exit(&dn->dn_struct_rwlock);

    char *nodes_json = json_array_end(ctx.nodes, ctx.count > 0);
    free(ctx.nodes);
    if (nodes_json == NULL)
        return make_error(ENOMEM, "failed to finalize node array");

    char objset_buf[32];
    const char *objset_json = "null";
    if (has_objset_id) {
        (void)snprintf(objset_buf, sizeof (objset_buf), "%llu",
            (unsigned long long)objset_id);
        objset_json = objset_buf;
    }

    char *result = json_format(
        "{"
        "\"scope\":\"%s\","
        "\"objset_id\":%s,"
        "\"object\":%llu,"
        "\"max_depth\":%llu,"
        "\"max_nodes\":%llu,"
        "\"count\":%d,"
        "\"truncated\":%s,"
        "\"nodes\":%s"
        "}",
        scope,
        objset_json,
        (unsigned long long)objid,
        (unsigned long long)max_depth,
        (unsigned long long)max_nodes,
        ctx.count,
        ctx.truncated ? "true" : "false",
        nodes_json);
    free(nodes_json);
    if (result == NULL)
        return make_error(ENOMEM, "failed to allocate JSON result");

    return make_success(result);
}

zdx_result_t
zdx_mos_block_tree(zdx_pool_t *pool, uint64_t objid, uint64_t max_depth,
    uint64_t max_nodes)
{
    if (!pool || !pool->spa)
        return make_error(EINVAL, "pool not open");

    objset_t *mos = spa_meta_objset(pool->spa);
    if (mos == NULL)
        return make_error(EINVAL, "failed to access MOS");

    dnode_t *dn = NULL;
    int err = dnode_hold(mos, objid, FTAG, &dn);
    if (err != 0)
        return make_error(err, "dnode_hold failed for object %llu",
            (unsigned long long)objid);

    zdx_result_t result = zdx_block_tree_from_dnode("mos", 0, B_FALSE, objid,
        dn, max_depth, max_nodes);
    dnode_rele(dn, FTAG);
    return (result);
}

zdx_result_t
zdx_objset_block_tree(zdx_pool_t *pool, uint64_t objset_id, uint64_t objid,
    uint64_t max_depth, uint64_t max_nodes)
{
    if (!pool || !pool->spa)
        return make_error(EINVAL, "pool not open");

    spa_t *spa = pool->spa;
    dsl_dataset_t *ds = NULL;
    objset_t *os = NULL;
    dnode_t *dn = NULL;
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

    err = dnode_hold(os, objid, FTAG, &dn);
    if (err != 0) {
        dsl_dataset_rele(ds, FTAG);
        dsl_pool_config_exit(spa->spa_dsl_pool, FTAG);
        return make_error(err, "dnode_hold failed for object %llu",
            (unsigned long long)objid);
    }

    zdx_result_t result = zdx_block_tree_from_dnode("objset", objset_id,
        B_TRUE, objid, dn, max_depth, max_nodes);
    dnode_rele(dn, FTAG);
    dsl_dataset_rele(ds, FTAG);
    dsl_pool_config_exit(spa->spa_dsl_pool, FTAG);
    return (result);
}
