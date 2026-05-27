import { StreamProvider, ResolvedMedia, SearchResult, BrowseResult } from './types.js';
import logger from '../../utils/logger.js';

export class ProviderManager {
	private providers: StreamProvider[] = [];

	register(provider: StreamProvider): void {
		this.providers.push(provider);
		logger.info(`Provider registered: ${provider.name}`);
	}

	async resolve(input: string): Promise<ResolvedMedia | null> {
		for (const provider of this.providers) {
			if (provider.canHandle(input)) {
				try {
					const result = await provider.resolve(input);
					if (result) return result;
				} catch (error) {
					logger.error(`Provider ${provider.name} failed to resolve "${input}":`, error);
				}
			}
		}
		return null;
	}

	async search(query: string, limit?: number): Promise<SearchResult[]> {
		for (const provider of this.providers) {
			if (provider.search) {
				try {
					const results = await provider.search(query, limit);
					if (results.length > 0) return results;
				} catch (error) {
					logger.error(`Provider ${provider.name} search failed:`, error);
				}
			}
		}
		return [];
	}

	getBrowsableProviders(): StreamProvider[] {
		return this.providers.filter(p => typeof p.browse === 'function');
	}

	async browse(providerName: string, path?: string): Promise<BrowseResult | null> {
		const provider = this.providers.find(p => p.name === providerName && typeof p.browse === 'function');
		if (!provider?.browse) return null;
		try {
			return await provider.browse(path);
		} catch (error) {
			logger.error(`Provider ${providerName} browse failed:`, error);
			return null;
		}
	}

	getProvider(name: string): StreamProvider | undefined {
		return this.providers.find(p => p.name === name);
	}
}
