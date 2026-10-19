import { decodeWebBytes } from "../../src/shared/webText";

/** 仅用于隔离本地workerd，核验实际Workers的字符集支持，不能部署为业务入口。 */
export default {
  fetch(request: Request): Response {
    if (!['127.0.0.1','localhost'].includes(new URL(request.url).hostname)) return new Response('Local only',{status:403});
    const failures: string[] = [];
    const check = (label: string, bytes: number[], type: string, expected: string) => {
      try { if (decodeWebBytes(new Uint8Array(bytes), type) !== expected) failures.push(label); }
      catch (e) { failures.push(`${label}: ${String(e)}`); }
    };
    check('gb2312',[0xd6,0xd0,0xce,0xc4],'text/html;charset=gb2312','中文');
    check('gb18030',[0xd6,0xd0,0xce,0xc4],'text/html;charset=gb18030','中文');
    check('big5',[0xa4,0xa4,0xa4,0xe5],'text/html;charset=big5','中文');
    check('utf8',[0xe4,0xb8,0xad],'text/html','中');
    check('utf16be',[0xfe,0xff,0x4e,0x2d],'text/html','中');
    try { decodeWebBytes(new Uint8Array([0xff])); failures.push('fatal decoding not enforced'); } catch {}
    return Response.json({ fixture:'web-encoding-local', failures });
  },
};
