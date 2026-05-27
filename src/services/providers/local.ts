import path from 'path';
import { StreamProvider, ResolvedMedia } from './types.js';
import { GeneralUtils } from '../../utils/shared.js';

export class LocalProvider implements StreamProvider {
	readonly name = 'local';

	canHandle(input: string): boolean {
		return GeneralUtils.isLocalFile(input);
	}

	async resolve(input: string): Promise<ResolvedMedia | null> {
		return {
			streamUrl: input,
			title: path.basename(input, path.extname(input)),
			provider: this.name,
			isLive: false,
			seekable: true,
		};
	}
}
