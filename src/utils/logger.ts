import winston from 'winston';
import Transport from 'winston-transport';

// In-memory log buffer for the web UI
const LOG_BUFFER_SIZE = 500;
const logBuffer: { timestamp: string; level: string; message: string }[] = [];

class MemoryTransport extends Transport {
	log(info: any, callback: () => void) {
		const entry = {
			timestamp: info.timestamp || new Date().toISOString(),
			level: info.level?.replace(/\u001b\[\d+m/g, '') || 'info',
			message: typeof info.message === 'string' ? info.message : String(info.message)
		};
		logBuffer.push(entry);
		if (logBuffer.length > LOG_BUFFER_SIZE) {
			logBuffer.splice(0, logBuffer.length - LOG_BUFFER_SIZE);
		}
		callback();
	}
}

// Custom log format
const logFormat = winston.format.combine(
	winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
	winston.format.colorize(),
	winston.format.printf(({ level, message, timestamp }) => {
		return `[${timestamp}] ${level}: ${message}`;
	})
);

// Plain format for memory transport (no ANSI colors)
const plainFormat = winston.format.combine(
	winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
	winston.format.printf(({ level, message, timestamp }) => {
		return message as string;
	})
);

// Create logger instance
const logger = winston.createLogger({
	level: 'info',
	format: logFormat,
	transports: [
		new winston.transports.Console(),
		new MemoryTransport({ format: plainFormat })
	]
});

export function getLogBuffer() {
	return logBuffer;
}

export default logger;
