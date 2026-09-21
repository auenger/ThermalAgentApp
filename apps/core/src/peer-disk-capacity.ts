import { statfs } from 'node:fs/promises'

const HEADROOM_BYTES = 512n * 1024n * 1024n
const INPUT_MULTIPLIER = 4n

export function requiredRemoteDiskBytes(inputSizeBytes: number): bigint {
  if (!Number.isSafeInteger(inputSizeBytes) || inputSizeBytes < 1) throw new Error('remote input size is invalid')
  return BigInt(inputSizeBytes) * INPUT_MULTIPLIER + HEADROOM_BYTES
}

export function hasAdvertisedDiskCapacity(freeDiskBytes: number | undefined, inputSizeBytes: number): boolean {
  // Older nodes omit this field; the Executor still checks actual free space at Offer time.
  return freeDiskBytes === undefined ||
    (Number.isSafeInteger(freeDiskBytes) && freeDiskBytes >= 0 && BigInt(freeDiskBytes) >= requiredRemoteDiskBytes(inputSizeBytes))
}

export async function localFreeDiskBytes(path: string): Promise<bigint> {
  const capacity = await statfs(path, { bigint: true })
  return capacity.bavail * capacity.bsize
}

export function heartbeatFreeDiskBytes(freeDiskBytes: bigint): number {
  return Number(freeDiskBytes > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : freeDiskBytes)
}
