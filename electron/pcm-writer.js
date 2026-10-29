const fs = require('node:fs');
const path = require('node:path');

function wavHeader(byteLength, sampleRate) {
  if (byteLength > 0xffffffff - 36) throw new Error('单个WAV文件超过4GiB限制');
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(byteLength + 36, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(byteLength, 40);
  return header;
}
function createPcmWriter(file, sampleRate) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, 'wx');
  let bytes = 0;
  let closed = false;
  fs.writeSync(fd, wavHeader(0, sampleRate));
  function append(data) {
    if (closed) throw new Error('录音文件已经关闭');
    const buffer = Buffer.from(data);
    if (buffer.length % 2) throw new Error('PCM字节数必须为偶数');
    if (bytes + buffer.length > 0xffffffff - 36) throw new Error('录音达到WAV文件大小上限');
    let offset = 0;
    while (offset < buffer.length) offset += fs.writeSync(fd, buffer, offset, buffer.length - offset, 44 + bytes + offset);
    bytes += buffer.length;
    fs.writeSync(fd, wavHeader(bytes, sampleRate), 0, 44, 0);
  }
  function close() {
    if (closed) return;
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    closed = true;
  }
  return { append, close, get bytes() { return bytes; }, get durationMs() { return bytes / (sampleRate * 2) * 1000; } };
}
module.exports = { createPcmWriter, wavHeader };
