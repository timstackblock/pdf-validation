/**
 * WHAT THIS FILE DOES
 *
 * Computes the fingerprint that ties a PDF to its database record. Production stores a SHA-256 hash of every file
 * it ingests; QA computes the same hash from the same bytes and looks it up. SHA-256 is a standard one-way
 * fingerprint: identical files always give the identical 64-character code, and changing even one byte gives a
 * completely different one, so a hash match means "this exact file", not merely "a file with the same name".
 * This is the ONLY identifier the validator trusts enough to proceed on; filenames and dates are too easy to reuse.
 * Input: a file path. Output: the hash as lowercase hex text.
 */
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
/** Read the whole file and return its SHA-256 fingerprint. Throws if the file cannot be read; callers treat that as REVIEW, not as a database defect. */
export const fileHash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
