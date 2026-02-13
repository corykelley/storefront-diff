import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { StorageProvider } from "./types.js";

export class LocalStorageProvider implements StorageProvider {
  private basePath: string;

  constructor(basePath = "./public") {
    this.basePath = basePath;
  }

  async write(relativePath: string, data: Buffer): Promise<void> {
    const fullPath = join(this.basePath, relativePath);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, data);
  }

  publicUrl(relativePath: string): string {
    return `/${relativePath}`;
  }
}

export class S3StorageProvider implements StorageProvider {
  async write(_relativePath: string, _data: Buffer): Promise<void> {
    throw new Error("S3StorageProvider not implemented");
  }

  publicUrl(_relativePath: string): string {
    throw new Error("S3StorageProvider not implemented");
  }
}

export function createStorageProvider(): StorageProvider {
  if (process.env.STORAGE_PROVIDER === "s3") {
    return new S3StorageProvider();
  }
  return new LocalStorageProvider();
}
