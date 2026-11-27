/**
 * CDP WebSocket 帧层测试（P2-2 修复：此前 encodeFrame/parseFrameHeader 零覆盖）。
 * 直接对导出的帧函数做 round-trip 与边界验证，无网络。
 */
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { CdpClient, WS_MAX_FRAME, encodeFrame, parseFrameHeader } from "../src/strategies/cdp.js"

/** 完整解析：head + payload（含掩码解码，模拟对端收我方帧的视角） */
function decodeFrame(buf) {
  const header = parseFrameHeader(buf)
  assert.ok(header, "frame header must parse")
  let payload = buf.subarray(header.headerSize, header.headerSize + header.payloadLen)
  if (header.mask) {
    const mk = buf.subarray(header.consumed, header.consumed + 4)
    const dec = Buffer.alloc(payload.length)
    for (let i = 0; i < payload.length; i++) dec[i] = payload[i] ^ mk[i % 4]
    payload = dec
  }
  return { header, payload: payload.toString("utf8") }
}

describe("CDP frame encode/decode", () => {
  it("短帧（payload < 126 字节）round-trip 且带掩码", () => {
    const msg = '{"id":1,"method":"Page.enable"}'
    const buf = encodeFrame(msg)
    const { header, payload } = decodeFrame(buf)
    assert.equal(header.opcode, 0x1)
    assert.equal(header.mask, true, "client frames must be masked (RFC6455)")
    assert.equal(header.payloadLen, msg.length)
    assert.equal(payload, msg)
  })

  it("126 长帧（126..65535）round-trip", () => {
    const msg = "x".repeat(300)
    const buf = encodeFrame(msg)
    const { header, payload } = decodeFrame(buf)
    assert.equal(header.payloadLen, 300)
    assert.equal(payload, msg)
  })

  it("127 长帧（>65535）round-trip", () => {
    const msg = "y".repeat(70000)
    const buf = encodeFrame(msg)
    const { header, payload } = decodeFrame(buf)
    assert.equal(header.payloadLen, 70000)
    assert.equal(payload, msg)
  })

  it("解析拒绝超限帧（WS_MAX_FRAME）", () => {
    const buf = Buffer.alloc(10)
    buf[0] = 0x81
    buf[1] = 0x80 | 127
    buf.writeUInt32BE(0, 2)
    buf.writeUInt32BE(WS_MAX_FRAME + 1, 6)
    assert.throws(() => parseFrameHeader(buf), /frame payload too large/)
  })

  it("空缓冲/不足头长度安全返回 null", () => {
    assert.equal(parseFrameHeader(Buffer.alloc(0)), null)
    assert.equal(parseFrameHeader(Buffer.from([0x81])), null)
  })
})

/** 构造服务端视角的帧（无掩码）。 */
function serverFrame(payload, { fin = true, opcode = 0x1 } = {}) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8")
  const len = body.length
  const first = (fin ? 0x80 : 0x00) | opcode
  let header
  if (len < 126) header = Buffer.from([first, len])
  else if (len <= 0xffff) header = Buffer.from([first, 126, (len >> 8) & 0xff, len & 0xff])
  else {
    header = Buffer.alloc(10)
    header[0] = first
    header[1] = 127
    header.writeUInt32BE(0, 2)
    header.writeUInt32BE(len, 6)
  }
  return Buffer.concat([header, body])
}

/** 不接网络的 CdpClient：ws 用最小替身，只观察 destroy / write。 */
function fakeClient() {
  const client = new CdpClient("http://127.0.0.1:9222", { timeoutMs: 1000 })
  const writes = []
  let destroyed = false
  client.ws = {
    destroy() { destroyed = true },
    end() {},
    write(buf) { writes.push(buf) },
  }
  return { client, writes, destroyed: () => destroyed }
}

describe("CDP 连接层：异常帧不得杀死宿主进程", () => {
  it("超限帧被就地拒绝：不抛异常、关闭连接、reject 所有 pending", () => {
    const { client, destroyed } = fakeClient()
    const rejected = []
    client.pending.set(7, { resolve() {}, reject(e) { rejected.push(e.message) } })
    const buf = Buffer.alloc(10)
    buf[0] = 0x81
    buf[1] = 127
    buf.writeUInt32BE(0, 2)
    buf.writeUInt32BE(WS_MAX_FRAME + 1, 6)
    assert.doesNotThrow(() => client._onData(buf))
    assert.equal(client.closed, true)
    assert.equal(destroyed(), true)
    assert.equal(rejected.length, 1)
    assert.match(rejected[0], /frame payload too large/)
  })

  it("超过旧 6MB 上限的正常帧可完整解析并派发（崩溃回归）", () => {
    const { client } = fakeClient()
    const pad = "x".repeat(7 * 1024 * 1024)
    const msg = JSON.stringify({ id: 1, result: { pad } })
    let resolved = null
    client.pending.set(1, { resolve(v) { resolved = v }, reject() {} })
    client._onData(serverFrame(msg))
    assert.ok(resolved, "7MB 级响应必须被正常派发")
    assert.equal(resolved.pad.length, pad.length)
  })

  it("分片消息（首帧 fin=false + continuation）被完整重组", () => {
    const { client } = fakeClient()
    const msg = JSON.stringify({ id: 9, result: { ok: true, pad: "y".repeat(300) } })
    let resolved = null
    client.pending.set(9, { resolve(v) { resolved = v }, reject() {} })
    client._onData(serverFrame(msg.slice(0, 100), { fin: false, opcode: 0x1 }))
    assert.equal(resolved, null, "首片不应提前派发")
    client._onData(serverFrame(msg.slice(100), { fin: true, opcode: 0x0 }))
    assert.ok(resolved)
    assert.equal(resolved.pad.length, 300)
  })

  it("ping 帧回复 pong（0xA），不打断后续消息", () => {
    const { client, writes } = fakeClient()
    client._onData(serverFrame("hi", { opcode: 0x9 }))
    assert.equal(writes.length, 1)
    assert.equal(writes[0][0], 0x8a)
  })

  it("完整帧被拆成两个 TCP chunk 时仍能解析", () => {
    const { client } = fakeClient()
    const msg = JSON.stringify({ id: 3, result: { ok: true } })
    const frame = serverFrame(msg)
    let resolved = null
    client.pending.set(3, { resolve(v) { resolved = v }, reject() {} })
    client._onData(frame.subarray(0, 5))
    assert.equal(resolved, null)
    client._onData(frame.subarray(5))
    assert.ok(resolved)
    assert.equal(resolved.ok, true)
  })

  it("分片总量超限即失败（小分片累加不得放大内存）", () => {
    const { client, destroyed } = fakeClient()
    client.maxFrame = 400
    const rejected = []
    client.pending.set(11, { resolve() {}, reject(e) { rejected.push(e.message) } })
    client._onData(serverFrame("a".repeat(300), { fin: false, opcode: 0x1 }))
    client._onData(serverFrame("b".repeat(300), { fin: true, opcode: 0x0 }))
    assert.equal(client.closed, true)
    assert.equal(destroyed(), true)
    assert.match(rejected[0], /fragmented message exceeds/)
  })

  it("超长 ping 的 pong 回包按 RFC6455 截到 125 字节", () => {
    const { client, writes } = fakeClient()
    client._onData(serverFrame("z".repeat(300), { opcode: 0x9 }))
    assert.equal(writes.length, 1)
    const header = parseFrameHeader(writes[0])
    assert.equal(header.opcode, 0xa)
    assert.equal(header.payloadLen, 125)
  })

  it("close 之后 cmd 立即拒绝，不再写入已销毁的 socket", async () => {
    const { client, writes } = fakeClient()
    await client.close()
    assert.equal(client.closed, true)
    const before = writes.length
    await assert.rejects(() => client.cmd("Page.enable", {}), /socket closed/)
    assert.equal(writes.length, before)
  })
})
