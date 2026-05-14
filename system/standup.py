import ctypes
import os
import sys
import time


def _total_physical_memory_bytes() -> int:
    """跨平台获取物理内存总量（字节）。Windows 无 os.sysconf。"""
    if sys.platform == "win32":
        class MEMORYSTATUSEX(ctypes.Structure):
            _fields_ = [
                ("dwLength", ctypes.c_ulong),
                ("dwMemoryLoad", ctypes.c_ulong),
                ("ullTotalPhys", ctypes.c_ulonglong),
                ("ullAvailPhys", ctypes.c_ulonglong),
                ("ullTotalPageFile", ctypes.c_ulonglong),
                ("ullAvailPageFile", ctypes.c_ulonglong),
                ("ullTotalVirtual", ctypes.c_ulonglong),
                ("ullAvailVirtual", ctypes.c_ulonglong),
                ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
            ]

        stat = MEMORYSTATUSEX()
        stat.dwLength = ctypes.sizeof(MEMORYSTATUSEX)
        if not ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(stat)):
            raise OSError("GlobalMemoryStatusEx 调用失败")
        return int(stat.ullTotalPhys)

    if hasattr(os, "sysconf"):
        try:
            page = os.sysconf("SC_PAGE_SIZE")
            pages = os.sysconf("SC_PHYS_PAGES")
            return int(page) * int(pages)
        except (ValueError, OSError, AttributeError):
            pass

    raise OSError("当前系统无法自动检测物理内存，请安装 psutil 或改用 Windows/Linux/macOS。")


def occupy_memory(percent: float) -> None:
    total_mem = _total_physical_memory_bytes()
    target_mem = int(total_mem * percent)

    print(f"系统总内存: {total_mem / (1024**3):.2f} GB")
    print(f"目标占用: {target_mem / (1024**3):.2f} GB ({percent * 100:.0f}%)")

    try:
        dummy_data = bytearray(target_mem)
        step = 1024 * 1024 * 100  # 每 100MB 写一次，减少页错误开销
        for i in range(0, target_mem, step):
            dummy_data[i] = 1

        print("内存占用成功，正在持续持有中... 按 Ctrl+C 退出")
        while True:
            time.sleep(1)
    except MemoryError:
        print("错误：内存不足，无法申请更多内存")
    except KeyboardInterrupt:
        print("\n释放内存并退出")


if __name__ == "__main__":
    occupy_memory(0.42)
