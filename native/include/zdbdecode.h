#ifndef ZDBDECODE_H
#define ZDBDECODE_H

#include <stdint.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Opaque handles */
typedef struct zdx_pool zdx_pool_t;

/* === Result type (all JSON functions return this) === */
typedef struct {
    char *json;       /* NUL-terminated, freed by zdx_free_result() */
    size_t len;       /* length excluding NUL */
    int err;          /* 0 = ok, otherwise errno-style */
    char *errmsg;     /* human-readable, also freed by zdx_free_result() */
} zdx_result_t;

/* Free a result structure (frees json and errmsg, zeroes struct) */
void zdx_free_result(zdx_result_t *r);

/* === Lifecycle (call once) === */
int zdx_init(void);   /* kernel_init(SPA_MODE_READ) */
void zdx_fini(void);  /* kernel_fini() */

/* === Pool operations === */
zdx_result_t zdx_list_pools(void);
zdx_pool_t *zdx_pool_open(const char *name, int *err);
zdx_pool_t *zdx_pool_open_offline(const char *name, const char *search_paths,
                                  int *err);
void zdx_pool_close(zdx_pool_t *pool);
zdx_result_t zdx_pool_info(zdx_pool_t *pool);
zdx_result_t zdx_pool_vdevs(zdx_pool_t *pool);
zdx_result_t zdx_pool_datasets(zdx_pool_t *pool);
zdx_result_t zdx_pool_summary(zdx_pool_t *pool);
zdx_result_t zdx_pool_errors(zdx_pool_t *pool, uint64_t cursor,
                             uint64_t limit, int resolve_paths);

/* === MOS object operations === */
zdx_result_t zdx_mos_list_objects(zdx_pool_t *pool, int type_filter,
                                   uint64_t start, uint64_t limit);
zdx_result_t zdx_mos_get_object(zdx_pool_t *pool, uint64_t objid);
zdx_result_t zdx_mos_get_blkptrs(zdx_pool_t *pool, uint64_t objid);
zdx_result_t zdx_obj_get(zdx_pool_t *pool, uint64_t objid);

/* === DMU type catalog === */
zdx_result_t zdx_list_dmu_types(void);

/* === ZAP operations === */
zdx_result_t zdx_zap_info(zdx_pool_t *pool, uint64_t objid);
zdx_result_t zdx_zap_entries(zdx_pool_t *pool, uint64_t objid,
                             uint64_t cursor, uint64_t limit);

/* === Raw block read === */
zdx_result_t zdx_read_block(zdx_pool_t *pool, uint64_t vdev,
                            uint64_t offset, uint64_t size);

/* === DSL traversal === */
zdx_result_t zdx_dsl_dir_children(zdx_pool_t *pool, uint64_t objid);
zdx_result_t zdx_dsl_dir_head(zdx_pool_t *pool, uint64_t objid);
zdx_result_t zdx_dsl_root_dir(zdx_pool_t *pool);

/* === Dataset / Objset === */
zdx_result_t zdx_dataset_snapshots(zdx_pool_t *pool, uint64_t dir_obj);
zdx_result_t zdx_dataset_snapshot_count(zdx_pool_t *pool, uint64_t dir_obj);
zdx_result_t zdx_dataset_objset(zdx_pool_t *pool, uint64_t dsobj);
zdx_result_t zdx_dataset_lineage(zdx_pool_t *pool, uint64_t dsobj,
                                 uint64_t max_prev, uint64_t max_next);
zdx_result_t zdx_objset_root(zdx_pool_t *pool, uint64_t objset_id);
zdx_result_t zdx_objset_dir_entries(zdx_pool_t *pool, uint64_t objset_id,
                                    uint64_t dir_obj, uint64_t cursor,
                                    uint64_t limit);
zdx_result_t zdx_objset_walk(zdx_pool_t *pool, uint64_t objset_id,
                             const char *path);
zdx_result_t zdx_objset_stat(zdx_pool_t *pool, uint64_t objset_id,
                             uint64_t objid);

/* === Spacemap inspection === */
zdx_result_t zdx_spacemap_summary(zdx_pool_t *pool, uint64_t objid);
zdx_result_t zdx_spacemap_ranges(zdx_pool_t *pool, uint64_t objid,
                                 uint64_t cursor, uint64_t limit);

/* === Version info === */
const char *zdx_version(void); /* returns OpenZFS commit hash (injected at build time) */

#ifdef __cplusplus
}
#endif

#endif /* ZDBDECODE_H */
