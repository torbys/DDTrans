// SPDX-License-Identifier: MIT
#include "../driver/Source/Inc/audio-ring.h"
#include <cassert>
#include <cstdio>
#include <deque>
#include <vector>
#include <random>
#include "../endpoint-names.h"

int main() {
    assert(DdtransEndpointNameMatches(L"DDTrans Virtual Input", L"DDTrans Virtual Input"));
    assert(DdtransEndpointNameMatches(L"DDTrans Virtual Microphone (DDTrans Virtual Audio)", L"DDTrans Virtual Microphone"));
    assert(!DdtransEndpointNameMatches(L"Speakers (DDTrans Virtual Input)", L"DDTrans Virtual Input"));
    assert(!DdtransEndpointNameMatches(L"DDTrans Virtual Input Backup", L"DDTrans Virtual Input"));
    assert(!DdtransEndpointNameMatches(nullptr, L"DDTrans Virtual Input"));
    DdtransAudioRing ring = {};
    DdSample out[32];
    for (auto& value : out) value = 123;
    DdtransRingRead(&ring, out, 32);
    for (auto value : out) assert(value == 0);
    DdtransRingSetProducer(&ring, true);
    DdSample input[] = {1, -2, 3, -4};
    DdtransRingWrite(&ring, input, 4);
    DdtransRingRead(&ring, out, 6);
    assert(out[0] == 1 && out[1] == -2 && out[2] == 3 && out[3] == -4 && out[4] == 0 && out[5] == 0);
    DdtransRingWrite(&ring, input, 4);
    DdtransRingSetProducer(&ring, false);
    DdtransRingWrite(&ring, input, 4);
    DdtransRingRead(&ring, out, 4);
    for (unsigned i = 0; i < 4; ++i) assert(out[i] == 0);
    DdtransRingSetProducer(&ring, true);
    DdtransRingRead(&ring, out, 4);
    for (unsigned i = 0; i < 4; ++i) assert(out[i] == 0);
    std::mt19937 random(1977);
    std::deque<DdSample> expected;
    for (unsigned trial = 0; trial < 50000; ++trial) {
        const unsigned count = random() % 9000;
        std::vector<DdSample> values(count);
        if (trial % 97 == 0) { DdtransRingClear(&ring); expected.clear(); }
        if (random() & 1) {
            for (auto& value : values) { value = static_cast<DdSample>(random()); expected.push_back(value); }
            while (expected.size() > DDTRANS_RING_SAMPLES) expected.pop_front();
            DdtransRingWrite(&ring, values.data(), count);
        } else {
            DdtransRingRead(&ring, values.data(), count);
            for (auto value : values) { const auto wanted = expected.empty() ? 0 : expected.front(); assert(value == wanted); if (!expected.empty()) expected.pop_front(); }
        }
        assert(ring.size == expected.size() && ring.size <= DDTRANS_RING_SAMPLES);
    }
    assert(ring.dropped > 0 && ring.silence > 0 && ring.delivered > 0);
    std::printf("{\"checks\":[\"endpoint-identity\",\"inactive-silence\",\"pcm-order\",\"underrun-zero-fill\",\"stop-flush\",\"restart-no-stale-audio\",\"overflow-keeps-newest\",\"50000-reference-model-operations\"],\"capacitySamples\":%u,\"capacityMs\":100}\n", DDTRANS_RING_SAMPLES);
    return 0;
}
