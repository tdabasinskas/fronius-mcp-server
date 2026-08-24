export interface FroniusConfig {
  host: string;
  port?: number;
  protocol?: 'http' | 'https';
  timeout?: number;
  defaultDeviceId?: number;
  retries?: number;
  retryDelay?: number;
}

export interface MCPConfig {
  name: string;
  version: string;
}

export interface HttpTransportConfig {
  host: string;
  port: number;
  path: string;
}

export interface TransportConfig {
  type: 'stdio' | 'http';
  http: HttpTransportConfig;
}

export interface AppConfig {
  fronius: FroniusConfig;
  mcp: MCPConfig;
  transport: TransportConfig;
  logLevel?: 'error' | 'warn' | 'info' | 'debug';
}