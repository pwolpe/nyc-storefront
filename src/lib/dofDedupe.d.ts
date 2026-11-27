export function parseDofYear(raw: string | null | undefined): number;
export function parseDofVacant(raw: string | null | undefined): boolean | null;
export function isFebSupplemental(filingDueDate: string | null | undefined): boolean;
export function dedupeDofRows<T extends Record<string, any>>(
	rows: T[],
	opts?: { fixedYear?: number }
): T[];
export function cleanDofActivity(
	raw: string | null | undefined,
	year: number,
	isVacant?: boolean
): string;
