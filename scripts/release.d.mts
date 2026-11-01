export class ReleaseError extends Error {}
export function parseVersion(text: string): [number, number, number];
export function isGreater(left: string, right: string): boolean;
export function datedChangelog(opts: { text: string; version: string; date: string }): string;
export function changelogSection(opts: { text: string; version: string }): string;
export function withVersion(opts: { text: string; version: string }): string;
