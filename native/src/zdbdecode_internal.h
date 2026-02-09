#ifndef ZDBDECODE_INTERNAL_H
#define ZDBDECODE_INTERNAL_H

#include "../include/zdbdecode.h"
#include "json.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdarg.h>
#include <errno.h>
#include <ctype.h>
#include <sys/stat.h>

/* ZFS headers */
#include <sys/zfs_context.h>
#include <sys/spa.h>
#include <sys/spa_impl.h>
#include <sys/dmu.h>
#include <sys/dnode.h>
#include <sys/blkptr.h>
#include <sys/dmu_objset.h>
#include <sys/dsl_dir.h>
#include <sys/dsl_dataset.h>
#include <sys/rrwlock.h>
#include <sys/zfs_znode.h>
#include <sys/zfs_sa.h>
#include <sys/sa.h>
#include <sys/zap.h>
#include <sys/zap_impl.h>
#include <sys/zfs_refcount.h>
#include <sys/vdev.h>
#include <sys/zio.h>
#include <sys/abd.h>
#include <libzpool.h>
#include <libzfs.h>
#include <libzutil.h>

/* Build-time version info */
#ifndef ZDX_GIT_SHA
#define ZDX_GIT_SHA "unknown"
#endif

/* Opaque pool handle backing type */
struct zdx_pool {
    char *name;
    spa_t *spa;
    boolean_t offline_mode;
    boolean_t imported_transient;
};

extern libzfs_handle_t *g_zfs;
zdx_result_t make_error(int err, const char *fmt, ...);
zdx_result_t make_success(char *json);
const char *dmu_ot_name_safe(dmu_object_type_t type);
char *bytes_to_hex(const uint8_t *data, size_t len);
char *numbers_preview(const void *data, uint64_t count, int int_len);
const char *dirent_type_name(uint64_t type);
uint64_t mode_to_dirent_type(uint64_t mode);
char *dup_range(const char *start, size_t len);
int append_semantic_edge(char **array, int *count, uint64_t source,
    uint64_t target, const char *label, const char *kind, double confidence);
int zdx_sa_setup(objset_t *os, sa_attr_type_t **tablep);

#endif /* ZDBDECODE_INTERNAL_H */
