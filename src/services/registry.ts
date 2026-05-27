import { StreamingService } from './streaming.js';

let streamingService: StreamingService | null = null;

export function registerStreamingService(service: StreamingService): void {
	streamingService = service;
}

export function getStreamingService(): StreamingService | null {
	return streamingService;
}
