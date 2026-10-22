// Runs the Kokoro voice model off the main thread so the page stays smooth.
import { createKokoroHost } from './kokoro-core.js';

const host = createKokoroHost((msg, transfer) => postMessage(msg, transfer || []));
self.onmessage = ({ data }) => host(data);
