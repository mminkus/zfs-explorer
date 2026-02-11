### zdx prefix

All native functions prefixed with `zdx_` belong to the ZFS Explorer
decode layer. This layer provides a stable, read-only interface for
inspecting ZFS on-disk structures without exposing OpenZFS internal
types across FFI boundaries.
