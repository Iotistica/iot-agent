export type MqttPayload =
	| { format: 'json'; data: object }
	| { format: 'msgpack'; data: object }
	| { format: 'binary'; data: Buffer }
	| { format: 'text'; data: string };

export interface ShellMqttClient {
	subscribe(topic: string, options: { qos: 0 | 1 | 2 }, handler: (topic: string, payload: Buffer) => void): Promise<void>;
	publish(topic: string, payload: MqttPayload | Buffer | string, options?: { qos?: 0 | 1 | 2; retain?: boolean }): Promise<void>;
	unsubscribe(topic: string): Promise<void>;
}

export interface JobsMqttClient {
	subscribe(topic: string, options: { qos: 0 | 1 | 2 }, handler: (topic: string, payload: Buffer) => void): Promise<void>;
	unsubscribe(topic: string): Promise<void>;
	publishNoQueue(topic: string, payload: string, options?: { qos?: 0 | 1 | 2 }): Promise<void>;
	isConnected(): boolean;
}
