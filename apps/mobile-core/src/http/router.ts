/** 极简路由：够用就好，不引入框架（核心只跑在本机回环）。 */
import type http from 'node:http';

export interface Ctx {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  params: Record<string, string>;
}

type Handler = (ctx: Ctx) => Promise<void> | void;

interface Route {
  method: string;
  segments: string[];
  handler: Handler;
}

export class Router {
  private routes: Route[] = [];

  add(method: string, pattern: string, handler: Handler): void {
    this.routes.push({ method, segments: pattern.split('/').filter((s) => s !== ''), handler });
  }

  get(pattern: string, handler: Handler): void {
    this.add('GET', pattern, handler);
  }

  post(pattern: string, handler: Handler): void {
    this.add('POST', pattern, handler);
  }

  match(method: string, pathname: string): { handler: Handler; params: Record<string, string> } | null {
    const parts = pathname.split('/').filter((s) => s !== '');
    // HEAD 复用 GET 的实现：媒体代理要能响应 HEAD 探测，处理器自己判断是否只回头
    const methods = method === 'HEAD' ? ['HEAD', 'GET'] : [method];
    for (const want of methods) {
      for (const route of this.routes) {
        if (route.method !== want) continue;
        if (route.segments.length !== parts.length) continue;
        const params: Record<string, string> = {};
        let ok = true;
        for (let i = 0; i < route.segments.length; i += 1) {
          const seg = route.segments[i] ?? '';
          const part = parts[i] ?? '';
          if (seg.startsWith(':')) params[seg.slice(1)] = decodeURIComponent(part);
          else if (seg !== part) {
            ok = false;
            break;
          }
        }
        if (ok) return { handler: route.handler, params };
      }
    }
    return null;
  }
}
