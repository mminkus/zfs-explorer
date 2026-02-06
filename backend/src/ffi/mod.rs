#![allow(non_upper_case_globals)]
#![allow(non_camel_case_types)]
#![allow(non_snake_case)]
#![allow(dead_code)]

mod bindings;

use std::ffi::{CStr, CString};
use std::sync::{Mutex, Once};

pub use bindings::*;

/// Global mutex around all FFI calls (per plan's concurrency model)
static FFI_MUTEX: Mutex<()> = Mutex::new(());

/// Ensure zdx_init() is called exactly once
static INIT: Once = Once::new();

/// Initialize ZFS library (called once via std::sync::Once)
pub fn init() -> Result<(), String> {
    let mut result = Ok(());

    INIT.call_once(|| {
        let _lock = FFI_MUTEX.lock().unwrap();
        let rc = unsafe { zdx_init() };
        if rc != 0 {
            result = Err(format!("zdx_init failed with code {}", rc));
        }
    });

    result
}

/// Safe wrapper for zdx_result_t
pub struct ZdxResult {
    inner: zdx_result_t,
}

impl ZdxResult {
    /// Create from raw zdx_result_t (takes ownership)
    pub fn from_raw(raw: zdx_result_t) -> Self {
        ZdxResult { inner: raw }
    }

    /// Check if result is successful
    pub fn is_ok(&self) -> bool {
        self.inner.err == 0
    }

    /// Get JSON string (if available)
    pub fn json(&self) -> Option<&str> {
        if self.inner.json.is_null() {
            return None;
        }
        unsafe { CStr::from_ptr(self.inner.json).to_str().ok() }
    }

    /// Get error message (if available)
    pub fn error_msg(&self) -> Option<&str> {
        if self.inner.errmsg.is_null() {
            return None;
        }
        unsafe { CStr::from_ptr(self.inner.errmsg).to_str().ok() }
    }

    /// Get error code
    pub fn error_code(&self) -> i32 {
        self.inner.err
    }
}

impl Drop for ZdxResult {
    fn drop(&mut self) {
        let _lock = FFI_MUTEX.lock().unwrap();
        unsafe { zdx_free_result(&mut self.inner) };
    }
}

#[derive(Debug)]
pub struct PoolHandle {
    pub name: String,
    pub ptr: *mut zdx_pool_t,
}

unsafe impl Send for PoolHandle {}
unsafe impl Sync for PoolHandle {}

/// List all pools (behind mutex)
pub fn list_pools() -> ZdxResult {
    let _lock = FFI_MUTEX.lock().unwrap();
    let raw = unsafe { zdx_list_pools() };
    ZdxResult::from_raw(raw)
}

/// Open a pool (behind mutex)
pub fn pool_open(name: &str) -> Result<PoolHandle, (i32, String)> {
    let _lock = FFI_MUTEX.lock().unwrap();
    let c_name = CString::new(name).map_err(|e| (-1, e.to_string()))?;
    let mut err: i32 = 0;
    let ptr = unsafe { zdx_pool_open(c_name.as_ptr(), &mut err) };
    if ptr.is_null() {
        let msg = format!("zdx_pool_open failed with code {}", err);
        return Err((err, msg));
    }

    Ok(PoolHandle {
        name: name.to_string(),
        ptr,
    })
}

/// Close a pool (behind mutex)
pub fn pool_close(ptr: *mut zdx_pool_t) {
    if ptr.is_null() {
        return;
    }
    let _lock = FFI_MUTEX.lock().unwrap();
    unsafe { zdx_pool_close(ptr) };
}

/// List MOS objects
pub fn mos_list_objects(
    pool: *mut zdx_pool_t,
    type_filter: i32,
    start: u64,
    limit: u64,
) -> ZdxResult {
    let _lock = FFI_MUTEX.lock().unwrap();
    let raw = unsafe { zdx_mos_list_objects(pool, type_filter, start, limit) };
    ZdxResult::from_raw(raw)
}

/// Get MOS object info
pub fn mos_get_object(pool: *mut zdx_pool_t, objid: u64) -> ZdxResult {
    let _lock = FFI_MUTEX.lock().unwrap();
    let raw = unsafe { zdx_mos_get_object(pool, objid) };
    ZdxResult::from_raw(raw)
}

/// Get MOS object blkptrs
pub fn mos_get_blkptrs(pool: *mut zdx_pool_t, objid: u64) -> ZdxResult {
    let _lock = FFI_MUTEX.lock().unwrap();
    let raw = unsafe { zdx_mos_get_blkptrs(pool, objid) };
    ZdxResult::from_raw(raw)
}

/// Unified object fetch
pub fn obj_get(pool: *mut zdx_pool_t, objid: u64) -> ZdxResult {
    let _lock = FFI_MUTEX.lock().unwrap();
    let raw = unsafe { zdx_obj_get(pool, objid) };
    ZdxResult::from_raw(raw)
}

/// List DMU object types
pub fn list_dmu_types() -> ZdxResult {
    let _lock = FFI_MUTEX.lock().unwrap();
    let raw = unsafe { zdx_list_dmu_types() };
    ZdxResult::from_raw(raw)
}

/// Get ZAP info
pub fn zap_info(pool: *mut zdx_pool_t, objid: u64) -> ZdxResult {
    let _lock = FFI_MUTEX.lock().unwrap();
    let raw = unsafe { zdx_zap_info(pool, objid) };
    ZdxResult::from_raw(raw)
}

/// Get ZAP entries
pub fn zap_entries(pool: *mut zdx_pool_t, objid: u64, cursor: u64, limit: u64) -> ZdxResult {
    let _lock = FFI_MUTEX.lock().unwrap();
    let raw = unsafe { zdx_zap_entries(pool, objid, cursor, limit) };
    ZdxResult::from_raw(raw)
}

/// DSL dir children
pub fn dsl_dir_children(pool: *mut zdx_pool_t, objid: u64) -> ZdxResult {
    let _lock = FFI_MUTEX.lock().unwrap();
    let raw = unsafe { zdx_dsl_dir_children(pool, objid) };
    ZdxResult::from_raw(raw)
}

/// DSL dir head dataset
pub fn dsl_dir_head(pool: *mut zdx_pool_t, objid: u64) -> ZdxResult {
    let _lock = FFI_MUTEX.lock().unwrap();
    let raw = unsafe { zdx_dsl_dir_head(pool, objid) };
    ZdxResult::from_raw(raw)
}

/// DSL root dir discovery
pub fn dsl_root_dir(pool: *mut zdx_pool_t) -> ZdxResult {
    let _lock = FFI_MUTEX.lock().unwrap();
    let raw = unsafe { zdx_dsl_root_dir(pool) };
    ZdxResult::from_raw(raw)
}

/// Dataset -> objset mapping
pub fn dataset_objset(pool: *mut zdx_pool_t, dsobj: u64) -> ZdxResult {
    let _lock = FFI_MUTEX.lock().unwrap();
    let raw = unsafe { zdx_dataset_objset(pool, dsobj) };
    ZdxResult::from_raw(raw)
}

/// Objset root lookup
pub fn objset_root(pool: *mut zdx_pool_t, objset_id: u64) -> ZdxResult {
    let _lock = FFI_MUTEX.lock().unwrap();
    let raw = unsafe { zdx_objset_root(pool, objset_id) };
    ZdxResult::from_raw(raw)
}

/// Directory entries from ZPL
pub fn objset_dir_entries(
    pool: *mut zdx_pool_t,
    objset_id: u64,
    dir_obj: u64,
    cursor: u64,
    limit: u64,
) -> ZdxResult {
    let _lock = FFI_MUTEX.lock().unwrap();
    let raw = unsafe { zdx_objset_dir_entries(pool, objset_id, dir_obj, cursor, limit) };
    ZdxResult::from_raw(raw)
}

/// Walk a path within a ZPL objset
pub fn objset_walk(pool: *mut zdx_pool_t, objset_id: u64, path: &str) -> Result<ZdxResult, String> {
    let c_path = CString::new(path).map_err(|_| "path contains NUL".to_string())?;
    let _lock = FFI_MUTEX.lock().unwrap();
    let raw = unsafe { zdx_objset_walk(pool, objset_id, c_path.as_ptr()) };
    Ok(ZdxResult::from_raw(raw))
}

/// Stat a ZPL znode object
pub fn objset_stat(pool: *mut zdx_pool_t, objset_id: u64, objid: u64) -> ZdxResult {
    let _lock = FFI_MUTEX.lock().unwrap();
    let raw = unsafe { zdx_objset_stat(pool, objset_id, objid) };
    ZdxResult::from_raw(raw)
}

/// Read raw block by vdev + offset
pub fn read_block(pool: *mut zdx_pool_t, vdev: u64, offset: u64, size: u64) -> ZdxResult {
    let _lock = FFI_MUTEX.lock().unwrap();
    let raw = unsafe { zdx_read_block(pool, vdev, offset, size) };
    ZdxResult::from_raw(raw)
}

/// Get version string
pub fn version() -> &'static str {
    let _lock = FFI_MUTEX.lock().unwrap();
    let cstr = unsafe { CStr::from_ptr(zdx_version()) };
    cstr.to_str().unwrap_or("unknown")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_version() {
        let ver = version();
        assert!(!ver.is_empty());
    }
}
