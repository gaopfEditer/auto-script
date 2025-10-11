#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import os
import shutil
import glob

def fix_file_encoding(file_path):
    """模拟用户的手动操作：读取文件内容，重新创建文件"""
    if not os.path.exists(file_path):
        return False
    
    # 创建备份
    backup_path = f"{file_path}.bak"
    shutil.copy2(file_path, backup_path)
    print(f"Backed up: {file_path} -> {backup_path}")
    
    try:
        # 读取文件内容（尝试不同编码）
        content = None
        encodings = ['utf-8', 'utf-16', 'utf-16le', 'utf-16be', 'latin1', 'cp1252']
        
        for encoding in encodings:
            try:
                with open(file_path, 'r', encoding=encoding) as f:
                    content = f.read()
                print(f"Successfully read {file_path} with {encoding} encoding")
                break
            except (UnicodeDecodeError, UnicodeError):
                continue
        
        if content is None:
            print(f"Failed to read {file_path} with any encoding")
            return False
        
        # 创建新文件
        new_path = f"{file_path}.new"
        with open(new_path, 'w', encoding='utf-8') as f:
            f.write(content)
        
        # 删除原文件
        os.remove(file_path)
        
        # 重命名新文件
        os.rename(new_path, file_path)
        
        print(f"Fixed: {file_path}")
        return True
        
    except Exception as e:
        print(f"Error processing {file_path}: {e}")
        return False

def cleanup_backup_files():
    """删除所有.bak和.backup备份文件"""
    backup_files = []
    
    # 遍历所有子目录，找到备份文件
    for root, dirs, files in os.walk('.'):
        # 跳过一些不需要处理的目录
        dirs[:] = [d for d in dirs if not d.startswith('.') and d != 'vendor' and d != 'node_modules' and d != 'target' and d != 'build' and d != 'dist']
        
        for file in files:
            if file.endswith('.bak') or file.endswith('.backup'):
                file_path = os.path.join(root, file)
                backup_files.append(file_path)
    
    print(f"Found {len(backup_files)} backup files to delete")
    
    deleted_count = 0
    for file_path in backup_files:
        try:
            os.remove(file_path)
            print(f"Deleted: {file_path}")
            deleted_count += 1
        except Exception as e:
            print(f"Error deleting {file_path}: {e}")
    
    print(f"Deleted {deleted_count}/{len(backup_files)} backup files")

def main():
    # 定义需要处理的文本文件扩展名
    text_extensions = {
        '.go', '.py', '.js', '.ts', '.jsx', '.tsx', '.vue', '.html', '.htm', '.css', '.scss', '.sass', '.less',
        '.json', '.xml', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.config', '.properties',
        '.md', '.txt', '.log', '.sql', '.sh', '.bat', '.ps1', '.bash', '.zsh', '.fish',
        '.c', '.cpp', '.h', '.hpp', '.cc', '.cxx', '.java', '.kt', '.scala', '.rb', '.php',
        '.rs', '.swift', '.dart', '.r', '.m', '.mm', '.pl', '.pm', '.lua', '.go',
        '.dockerfile', '.dockerignore', '.gitignore', '.gitattributes', '.editorconfig',
        '.env', '.env.local', '.env.development', '.env.production', '.env.test',
        '.csv', '.tsv', '.xlsx', '.docx', '.pptx', '.rtf', '.tex', '.rst', '.adoc',
        '.svg', '.graphql', '.gql', '.prisma', '.proto', '.thrift', '.avro', '.parquet'
    }
    
    # 遍历项目目录，找到所有文本文件
    text_files = []
    
    # 遍历所有子目录
    for root, dirs, files in os.walk('.'):
        # 跳过一些不需要处理的目录
        dirs[:] = [d for d in dirs if not d.startswith('.') and d != 'vendor' and d != 'node_modules' and d != 'target' and d != 'build' and d != 'dist']
        
        for file in files:
            # 获取文件扩展名
            _, ext = os.path.splitext(file.lower())
            
            # 检查是否是文本文件且不是备份文件
            if ext in text_extensions and not file.endswith('.bak') and not file.endswith('.backup'):
                file_path = os.path.join(root, file)
                text_files.append(file_path)
    
    print(f"Found {len(text_files)} text files to process")
    
    success_count = 0
    for file_path in text_files:
        if fix_file_encoding(file_path):
            success_count += 1
    
    print(f"\nProcessed {success_count}/{len(text_files)} files successfully")
    
    # 清理备份文件
    print("\nCleaning up backup files...")
    cleanup_backup_files()

if __name__ == "__main__":
    main()
