# memory_stress.py
import time

# 占用约 2GB 内存（可调整）
data = bytearray(12 * 1024 * 1024 * 1024)  # 2GB

print("已分配 2GB 内存，按 Ctrl+C 退出...")
try:
    while True:
        time.sleep(1)
except KeyboardInterrupt:
    print("释放内存，退出。")