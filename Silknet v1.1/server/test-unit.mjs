// Silknet v1.1 Comprehensive Unit & Functional Verification Suite
// Tests PrivacyShield, TabManager, Attachment Rules, Synthesizer, and DOM extractors.

import { PrivacyShield } from './dist/sanitizer.js';
import { TabManager } from './dist/tab-manager.js';
import { SynthesizerEngine } from './dist/synthesizer.js';

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✅ PASS: ${message}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${message}`);
    failed++;
  }
}

console.log('========================================================');
console.log('🧪 SILKNET v1.1 CORE ENGINE UNIT & SECURITY AUDIT');
console.log('========================================================\n');

// 1. PrivacyShield Security & Redaction Tests
console.log('1. PrivacyShield Redaction Tests:');
{
  const text = 'Check C:\\Users\\jack0\\Desktop\\project\\secret.env with sk-abcdef1234567890abcdef1234567890 and AWS key AKIAIOSFODNN7EXAMPLE and IP 192.168.1.100';
  const result = PrivacyShield.sanitize(text, 'jack0');

  assert(!result.cleanText.includes('sk-abcdef1234567890abcdef1234567890'), 'OpenAI API key was redacted');
  assert(result.cleanText.includes('[REDACTED_OPENAI_API_KEY]'), 'API key replaced with redacted token');
  assert(!result.cleanText.includes('AKIAIOSFODNN7EXAMPLE'), 'AWS access key was redacted');
  assert(!result.cleanText.includes('192.168.1.100'), 'External IP address was redacted');
  assert(result.cleanText.includes('[PROJECT]/Desktop/project/secret.env'), 'Windows user path was neutralized to relative [PROJECT]/ path');
  assert(!result.cleanText.includes('jack0'), 'User name "jack0" was redacted');
  assert(result.redactedCount >= 4, `Redacted ${result.redactedCount} items`);
}

// 2. TabManager Attachment Constraints Tests
console.log('\n2. Attachment Validation & Rejection Constraints:');
{
  const tm = new TabManager();

  // Valid files (text, png, pdf)
  let validError = null;
  try {
    tm.validateAttachments([
      { name: 'notes.txt', size: 100, mimeType: 'text/plain', base64: 'abc' },
      { name: 'diagram.png', size: 5000, mimeType: 'image/png', base64: 'abc' },
      { name: 'doc.pdf', size: 20000, mimeType: 'application/pdf', base64: 'abc' }
    ]);
  } catch (e) {
    validError = e;
  }
  assert(validError === null, 'Accepted standard text, png, and pdf files');

  // Forbidden 3D file (.obj)
  let rejected3D = false;
  try {
    tm.validateAttachments([{ name: 'model.obj', size: 100, mimeType: 'model/obj', base64: 'abc' }]);
  } catch (e) {
    rejected3D = e.message.includes('Forbidden file format');
  }
  assert(rejected3D, 'Rejected forbidden 3D format (.obj)');

  // Forbidden 3D format (.gltf)
  let rejectedGltf = false;
  try {
    tm.validateAttachments([{ name: 'scene.gltf', size: 100, mimeType: 'model/gltf+json', base64: 'abc' }]);
  } catch (e) {
    rejectedGltf = e.message.includes('Forbidden file format');
  }
  assert(rejectedGltf, 'Rejected forbidden 3D format (.gltf)');

  // Forbidden Video format (.mp4)
  let rejectedVideo = false;
  try {
    tm.validateAttachments([{ name: 'test.mp4', size: 100, mimeType: 'video/mp4', base64: 'abc' }]);
  } catch (e) {
    rejectedVideo = e.message.includes('Forbidden file format');
  }
  assert(rejectedVideo, 'Rejected forbidden video format (.mp4)');

  // Forbidden Audio format (.mp3)
  let rejectedAudio = false;
  try {
    tm.validateAttachments([{ name: 'voice.mp3', size: 100, mimeType: 'audio/mp3', base64: 'abc' }]);
  } catch (e) {
    rejectedAudio = e.message.includes('Forbidden file format');
  }
  assert(rejectedAudio, 'Rejected forbidden audio format (.mp3)');

  // Forbidden Audio format (.wav)
  let rejectedWav = false;
  try {
    tm.validateAttachments([{ name: 'recording.wav', size: 100, mimeType: 'audio/wav', base64: 'abc' }]);
  } catch (e) {
    rejectedWav = e.message.includes('Forbidden file format');
  }
  assert(rejectedWav, 'Rejected forbidden audio format (.wav)');

  // Max 5 file count limit
  let rejectedCount = false;
  try {
    const files = Array.from({ length: 6 }, (_, i) => ({
      name: `file${i}.txt`, size: 10, mimeType: 'text/plain', base64: 'abc'
    }));
    tm.validateAttachments(files);
  } catch (e) {
    rejectedCount = e.message.includes('Maximum 5 files');
  }
  assert(rejectedCount, 'Rejected exceeding maximum 5 file limit');

  // Max 20MB total size limit
  let rejectedSize = false;
  try {
    tm.validateAttachments([{ name: 'big.bin', size: 21 * 1024 * 1024, mimeType: 'text/plain', base64: 'abc' }]);
  } catch (e) {
    rejectedSize = e.message.includes('exceeds maximum allowed limit of 20 MB');
  }
  assert(rejectedSize, 'Rejected exceeding 20 MB total size limit');
}

// 3. TabManager Lifecycle & Emergency Killswitch Tests
console.log('\n3. TabManager Lifecycle & Emergency Killswitch:');
{
  const tm = new TabManager();
  const mockWs = { readyState: 1, send: () => {} };

  // Register tabs
  tm.registerTab(mockWs, { id: 't1', provider: 'chatgpt', title: 'ChatGPT Tab', url: 'https://chatgpt.com/' });
  tm.registerTab(mockWs, { id: 't2', provider: 'claude', title: 'Claude Tab', url: 'https://claude.ai/new' });
  tm.registerTab(mockWs, { id: 't3', provider: 'gemini', title: 'Gemini Tab', url: 'https://gemini.google.com/app' });

  assert(tm.getActiveProviders().length === 3, 'Registered all 3 AI providers');

  // Human Gate
  tm.setRequireApproval(true);
  assert(tm.isApprovalRequired() === true, 'Human Approval Gate active');

  const approvalPromise = tm.requestApproval({
    caller: 'Test',
    task: 'Sample task',
    prompt: 'Sample prompt',
    provider: 'chatgpt'
  });

  const pending = tm.getPendingApprovals();
  assert(pending.length === 1, 'Approval recorded in pending list');

  const resolved = tm.resolveApproval(pending[0].id, true);
  assert(resolved === true, 'Resolved approval successfully');

  const approvedResult = await approvalPromise;
  assert(approvedResult === true, 'Approval promise returned true');

  // Emergency Killswitch
  const abortedCount = tm.abortAll();
  assert(abortedCount === 0, 'Killswitch executed cleanly without lingering requests');
}

// 4. Synthesizer Consensus Formatting Tests
console.log('\n4. Synthesizer Multi-Tab Consensus Formatting:');
{
  const userTask = 'Build a resilient caching layer in Node.js';
  const responses = [
    { provider: 'claude', reply: 'Use Redis with automatic key expiration and circuit breakers.', success: true },
    { provider: 'chatgpt', reply: 'Implement a two-tier cache with in-memory LRU and distributed Redis.', success: true },
    { provider: 'gemini', reply: 'Use cache-aside pattern with TTL and staggered refreshing.', success: true }
  ];

  const { formattedText, breakdown } = SynthesizerEngine.formatConsensusPrompt(userTask, responses);

  assert(formattedText.includes('Claude said:'), 'Formatted prompt contains Claude block');
  assert(formattedText.includes('ChatGPT suggested:'), 'Formatted prompt contains ChatGPT block');
  assert(formattedText.includes('Gemini recommends:'), 'Formatted prompt contains Gemini block');
  assert(breakdown.claude.includes('Redis with automatic key expiration'), 'Breakdown captures Claude reply');
  assert(breakdown.chatgpt.includes('two-tier cache'), 'Breakdown captures ChatGPT reply');
  assert(breakdown.gemini.includes('cache-aside pattern'), 'Breakdown captures Gemini reply');

  // Deterministic local consensus test (Offline fallback when Ollama is not active)
  const synthesis = await SynthesizerEngine.synthesize(userTask, responses);
  assert(Boolean(synthesis.consensus), 'Synthesizer generated cohesive consensus');
  assert(Object.keys(synthesis.breakdown).length === 3, 'Synthesis breakdown contains all 3 models');
  console.log(`     Synthesis Source: ${synthesis.sourceModel}`);
}

console.log('\n========================================================');
console.log(`UNIT & FUNCTIONAL AUDIT: ${passed} PASSED, ${failed} FAILED`);
console.log('========================================================');

if (failed > 0) {
  process.exit(1);
} else {
  process.exit(0);
}
