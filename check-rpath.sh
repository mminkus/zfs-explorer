#!/bin/bash
# Diagnostic script to check RUNPATH issues

BINARY="./backend/target/debug/zfs-explorer"

echo "=== RUNPATH Diagnostic ==="
echo ""

echo "1. Checking if binary exists:"
ls -lh "$BINARY" || { echo "ERROR: Binary not found!"; exit 1; }
echo ""

echo "2. Checking RUNPATH in binary:"
readelf -d "$BINARY" | grep -E '(RPATH|RUNPATH)'
echo ""

echo "3. Resolving \$ORIGIN (binary is at: $(readlink -f "$BINARY"))"
ORIGIN=$(dirname "$(readlink -f "$BINARY")")
echo "   \$ORIGIN = $ORIGIN"
echo "   \$ORIGIN/../../native = $ORIGIN/../../native"
echo "   \$ORIGIN/../../_deps/openzfs/lib = $ORIGIN/../../_deps/openzfs/lib"
echo ""

echo "4. Checking if libzdbdecode.so exists in expected location:"
if [ -f "$ORIGIN/../../native/libzdbdecode.so" ]; then
    echo "   ✓ Found: $ORIGIN/../../native/libzdbdecode.so"
    ls -lh "$ORIGIN/../../native/libzdbdecode.so"
else
    echo "   ✗ NOT FOUND: $ORIGIN/../../native/libzdbdecode.so"
fi
echo ""

echo "5. Checking if OpenZFS libs exist:"
if [ -d "$ORIGIN/../../_deps/openzfs/lib" ]; then
    echo "   ✓ Directory exists: $ORIGIN/../../_deps/openzfs/lib"
    echo "   Libraries:"
    ls -lh "$ORIGIN/../../_deps/openzfs/lib"/*.so* | head -5
else
    echo "   ✗ NOT FOUND: $ORIGIN/../../_deps/openzfs/lib"
fi
echo ""

echo "6. Testing library loading with ldd:"
ldd "$BINARY" | grep -E '(libzdbdecode|libzpool|libzfs\.so\.6)'
echo ""

echo "7. If running on nexus, try:"
echo "   sudo LD_LIBRARY_PATH=\"\$ORIGIN/../../native:\$ORIGIN/../../_deps/openzfs/lib\" ./backend/target/debug/zfs-explorer"
echo ""
echo "8. RUNPATH doesn't work with sudo if binary isn't in secure_path or if SELinux blocks it"
echo "   Workaround: Use absolute path in LD_LIBRARY_PATH"
