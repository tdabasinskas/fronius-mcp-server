#!/usr/bin/env node

import * as http from 'node:http';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { FroniusAPIClient } from './services/fronius-api.js';
import { getDefaultConfig, validateConfig } from './services/config.js';
import { ResourceHandler } from './handlers/resources.js';
import { ToolHandler } from './handlers/tools.js';
import type { AppConfig } from './types/config.js';

/** Maximum accepted HTTP request body size (1 MB). */
const MAX_HTTP_BODY_BYTES = 1024 * 1024;

export class FroniusMCPServer {
  private config: AppConfig;
  private apiClient: FroniusAPIClient;
  private resourceHandler: ResourceHandler;
  private toolHandler: ToolHandler;
  private httpServer?: http.Server;

  constructor() {
    this.config = getDefaultConfig();
    this.validateConfiguration();

    this.apiClient = new FroniusAPIClient(this.config.fronius);
    this.resourceHandler = new ResourceHandler(this.apiClient);
    this.toolHandler = new ToolHandler(this.apiClient);

    this.setupErrorHandling();
  }

  /**
   * Build a fresh MCP Server instance with all handlers wired up.
   *
   * A new instance is created per stateless HTTP request so that concurrent
   * requests never share JSON-RPC message state; the underlying API client and
   * handlers are stateless and safely reused across instances.
   */
  private createServer(): Server {
    const server = new Server(
      {
        name: this.config.mcp.name,
        version: this.config.mcp.version,
      },
      {
        capabilities: {
          resources: {},
          tools: {},
        },
      }
    );

    this.wireHandlers(server);
    return server;
  }

  private validateConfiguration(): void {
    const errors = validateConfig(this.config);
    if (errors.length > 0) {
      console.error('[CONFIG] Configuration errors:');
      errors.forEach(error => console.error(`  - ${error}`));
      process.exit(1);
    }
    
    console.error(`[CONFIG] Fronius host: ${this.config.fronius.host}:${this.config.fronius.port}`);
    console.error(`[CONFIG] Protocol: ${this.config.fronius.protocol}`);
    console.error(`[CONFIG] Timeout: ${this.config.fronius.timeout}ms`);
  }

  private wireHandlers(server: Server): void {
    // Resource handlers
    server.setRequestHandler(ListResourcesRequestSchema, async () => {
      console.error('[MCP] Listing resources');
      return await this.resourceHandler.listResources();
    });

    server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      console.error(`[MCP] Reading resource: ${request.params.uri}`);
      return await this.resourceHandler.readResource(request);
    });

    // Tool handlers
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      console.error('[MCP] Listing tools');
      return await this.toolHandler.listTools();
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      console.error(`[MCP] Calling tool: ${request.params.name}`);
      return await this.toolHandler.callTool(request);
    });
  }

  private setupErrorHandling(): void {
    process.on('SIGINT', () => {
      console.error('[SERVER] Received SIGINT, shutting down gracefully');
      process.exit(0);
    });

    process.on('SIGTERM', () => {
      console.error('[SERVER] Received SIGTERM, shutting down gracefully');
      process.exit(0);
    });

    process.on('uncaughtException', (error) => {
      console.error('[SERVER] Uncaught exception:', error);
      process.exit(1);
    });

    process.on('unhandledRejection', (reason, promise) => {
      console.error('[SERVER] Unhandled rejection at:', promise, 'reason:', reason);
      process.exit(1);
    });
  }

  async run(): Promise<void> {
    try {
      console.error('[SERVER] Starting Fronius MCP Server...');
      
      // Test connection on startup
      console.error('[SERVER] Testing Fronius connection...');
      const isConnected = await this.apiClient.testConnection();
      
      if (!isConnected) {
        console.error('[SERVER] Warning: Initial connection test failed. Server will start but may not function correctly.');
        console.error('[SERVER] Please verify:');
        console.error(`[SERVER]   - Fronius device is reachable at ${this.config.fronius.protocol}://${this.config.fronius.host}:${this.config.fronius.port}`);
        console.error('[SERVER]   - Device has Solar API enabled');
        console.error('[SERVER]   - Network connectivity is working');
      } else {
        console.error('[SERVER] ✓ Fronius connection test successful');
      }

      if (this.config.transport.type === 'http') {
        await this.startHttp();
      } else {
        await this.startStdio();
      }

      console.error(`[SERVER] Fronius MCP Server is running!`);
      console.error(`[SERVER] Configuration:`);
      console.error(`[SERVER]   - Host: ${this.config.fronius.host}:${this.config.fronius.port}`);
      console.error(`[SERVER]   - Protocol: ${this.config.fronius.protocol}`);
      console.error(`[SERVER]   - Default Device ID: ${this.config.fronius.defaultDeviceId}`);
      console.error(`[SERVER]   - Timeout: ${this.config.fronius.timeout}ms`);
      console.error(`[SERVER]   - Retries: ${this.config.fronius.retries}`);

    } catch (error) {
      console.error('[SERVER] Failed to start server:', error);
      process.exit(1);
    }
  }

  private async startStdio(): Promise<void> {
    const server = this.createServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('[SERVER]   - Transport: stdio');
  }

  private async startHttp(): Promise<void> {
    const { host, port, path } = this.config.transport.http;

    const httpServer = http.createServer((req, res) => {
      this.handleHttpRequest(req, res).catch((error) => {
        console.error('[HTTP] Unhandled request error:', error);
        this.sendJsonRpcError(res, 500, -32603, 'Internal server error');
      });
    });

    await new Promise<void>((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(port, host, () => {
        httpServer.removeListener('error', reject);
        resolve();
      });
    });

    this.httpServer = httpServer;
    console.error('[SERVER]   - Transport: http');
    console.error(`[SERVER]   - Endpoint: http://${host}:${port}${path}`);
  }

  private async handleHttpRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    const { path } = this.config.transport.http;
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    // Lightweight health endpoint for container/orchestrator probes.
    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }

    if (url.pathname !== path) {
      this.sendJsonRpcError(res, 404, -32601, 'Not found');
      return;
    }

    // Stateless transport only supports request/response over POST; there is no
    // long-lived SSE stream to attach to via GET, and no session to DELETE.
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      this.sendJsonRpcError(res, 405, -32601, 'Method not allowed; use POST');
      return;
    }

    const body = await this.readJsonBody(req, res);
    if (body === undefined) {
      return; // An error response was already sent while reading the body.
    }

    const server = this.createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless: no session tracking
      enableJsonResponse: true, // plain JSON responses instead of SSE streams
    });

    res.on('close', () => {
      void transport.close();
      void server.close();
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  /**
   * Read and JSON-parse an HTTP request body, enforcing a size limit. Sends the
   * appropriate JSON-RPC error response and resolves to `undefined` on failure.
   */
  private readJsonBody(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<unknown | undefined> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let size = 0;

      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_HTTP_BODY_BYTES) {
          this.sendJsonRpcError(res, 413, -32600, 'Request body too large');
          req.destroy();
          resolve(undefined);
          return;
        }
        chunks.push(chunk);
      });

      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8').trim();
        if (!raw) {
          this.sendJsonRpcError(res, 400, -32700, 'Empty request body');
          resolve(undefined);
          return;
        }
        try {
          resolve(JSON.parse(raw));
        } catch {
          this.sendJsonRpcError(res, 400, -32700, 'Parse error: invalid JSON');
          resolve(undefined);
        }
      });

      req.on('error', () => resolve(undefined));
    });
  }

  private sendJsonRpcError(
    res: http.ServerResponse,
    httpStatus: number,
    code: number,
    message: string
  ): void {
    if (res.headersSent) {
      return;
    }
    res.writeHead(httpStatus, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        error: { code, message },
        id: null,
      })
    );
  }

  close(): void {
    // Graceful shutdown - could add cleanup logic here if needed
    if (this.httpServer) {
      this.httpServer.close();
    }

    if (this.config.logLevel === 'debug' || this.config.logLevel === 'info') {
      console.error('[SERVER] Shutting down MCP server...');
    }
  }
}

// Only start server if this file is run directly (not imported)
if (import.meta.url === `file://${process.argv[1]}`) {
  // Environment variables documentation
  const envHelp = `
Environment Variables:
  FRONIUS_HOST          Fronius device hostname or IP (default: fronius-inverter)
  FRONIUS_PORT          Fronius device port (default: 80)
  FRONIUS_PROTOCOL      Protocol to use: http or https (default: http)
  FRONIUS_TIMEOUT       Request timeout in milliseconds (default: 10000)
  FRONIUS_DEVICE_ID     Default device ID for inverter calls (default: 1)
  FRONIUS_RETRIES       Number of retry attempts (default: 3)
  FRONIUS_RETRY_DELAY   Delay between retries in milliseconds (default: 1000)
  MCP_TRANSPORT         MCP transport: stdio or http (default: stdio)
  MCP_HTTP_HOST         HTTP transport bind host (default: 127.0.0.1)
  MCP_HTTP_PORT         HTTP transport port (default: 3000)
  MCP_HTTP_PATH         HTTP transport endpoint path (default: /mcp)
  LOG_LEVEL            Log level: error, warn, info, debug (default: info)

Example:
  FRONIUS_HOST=fronius-inverter.local FRONIUS_PROTOCOL=https npm start
  MCP_TRANSPORT=http MCP_HTTP_PORT=3000 npm start
`;

  // Show help if requested
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(envHelp);
    process.exit(0);
  }

  // Start the server
  const server = new FroniusMCPServer();
  server.run().catch((error) => {
    console.error('[SERVER] Fatal error:', error);
    process.exit(1);
  });
}