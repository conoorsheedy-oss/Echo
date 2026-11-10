# Third-party notices

Echo is MIT-licensed (see [LICENSE](LICENSE)). It uses these third-party components:

| Component | Used for | License | Source |
|---|---|---|---|
| [Electron](https://www.electronjs.org) (dev dependency) | App runtime | MIT (Chromium and other bundled parts under their own licenses; see `LICENSES.chromium.html` in the Electron distribution) | npm |
| [ws](https://github.com/websockets/ws) 8.21.3, by Einar Otto Stangvik and contributors | WebSocket client for Deepgram live speech-to-text (main process) | [MIT](https://github.com/websockets/ws/blob/master/LICENSE) | npm |
| [MediaPipe Tasks Vision](https://www.npmjs.com/package/@mediapipe/tasks-vision) `@mediapipe/tasks-vision` 0.10.35, by Google | Optional hand gestures (JS bundle + WebAssembly runtime) | [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0) | npm; copied into `src/renderer/vendor/mediapipe/` by `scripts/fetch-gesture-assets.js` |
| MediaPipe Gesture Recognizer model (`gesture_recognizer.task`, float16 v1), by Google | Optional hand gestures (model weights) | [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0) ([model card](https://developers.google.com/mediapipe/solutions/vision/gesture_recognizer)) | Downloaded once by `npm install` from `storage.googleapis.com/mediapipe-models/` |

MediaPipe and the gesture model are copyright Google LLC and are not modified by Echo. They are licensed under the Apache License, Version 2.0; you may not use these files except in compliance with the License. Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.

`@mediapipe/tasks-vision` is pinned to 0.10.35 on purpose: the 1.x releases add usage-metrics reporting to Google, which this offline feature doesn't need.
