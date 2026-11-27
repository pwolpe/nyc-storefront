declare global {
	namespace App {
		interface Platform {
			env?: Record<string, string | undefined>;
			context?: {
				waitUntil(promise: Promise<unknown>): void;
			};
		}
	}
}

export {};
