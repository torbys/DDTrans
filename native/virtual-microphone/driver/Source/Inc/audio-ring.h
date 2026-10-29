// SPDX-License-Identifier: MIT
#pragma once
#include <string.h>
typedef short DdSample;
typedef unsigned int DdCount;
typedef unsigned long long DdCounter;
static_assert(sizeof(DdSample) == 2 && sizeof(DdCount) == 4 && sizeof(DdCounter) == 8, "PCM and counters require fixed widths");

static const DdCount DDTRANS_SAMPLE_RATE = 48000;
static const DdCount DDTRANS_RING_SAMPLES = DDTRANS_SAMPLE_RATE / 10;
struct DdtransAudioRing {
    DdSample samples[DDTRANS_RING_SAMPLES];
    DdCount readIndex, size;
    DdCounter written, delivered, silence, dropped;
    bool producerRunning;
};
inline void DdtransRingClear(DdtransAudioRing* ring) {
    ring->readIndex = ring->size = 0;
}
inline void DdtransRingSetProducer(DdtransAudioRing* ring, bool running) {
    DdtransRingClear(ring);
    ring->producerRunning = running;
}
inline void DdtransRingWrite(DdtransAudioRing* ring, const DdSample* input, DdCount count) {
    if (!ring->producerRunning || count == 0) return;
    ring->written += count;
    if (count > DDTRANS_RING_SAMPLES) {
        const DdCount skip = count - DDTRANS_RING_SAMPLES;
        input += skip; count -= skip; ring->dropped += skip;
    }
    const DdCount excess = ring->size + count > DDTRANS_RING_SAMPLES ? ring->size + count - DDTRANS_RING_SAMPLES : 0;
    ring->readIndex = (ring->readIndex + excess) % DDTRANS_RING_SAMPLES;
    ring->size -= excess; ring->dropped += excess;
    const DdCount writeIndex = (ring->readIndex + ring->size) % DDTRANS_RING_SAMPLES;
    const DdCount first = count < DDTRANS_RING_SAMPLES - writeIndex ? count : DDTRANS_RING_SAMPLES - writeIndex;
    memcpy(ring->samples + writeIndex, input, first * sizeof(DdSample));
    if (count > first) memcpy(ring->samples, input + first, (count - first) * sizeof(DdSample));
    ring->size += count;
}
inline void DdtransRingRead(DdtransAudioRing* ring, DdSample* output, DdCount count) {
    const DdCount available = ring->producerRunning ? (count < ring->size ? count : ring->size) : 0;
    const DdCount first = available < DDTRANS_RING_SAMPLES - ring->readIndex ? available : DDTRANS_RING_SAMPLES - ring->readIndex;
    if (first) memcpy(output, ring->samples + ring->readIndex, first * sizeof(DdSample));
    if (available > first) memcpy(output + first, ring->samples, (available - first) * sizeof(DdSample));
    if (count > available) memset(output + available, 0, (count - available) * sizeof(DdSample));
    ring->readIndex = (ring->readIndex + available) % DDTRANS_RING_SAMPLES;
    ring->size -= available;
    ring->delivered += available; ring->silence += count - available;
}
