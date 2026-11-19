/**
 * @fileoverview The entry of `/form-preview.html` (a second page of the Vite build, vite.config.ts): the window's
 * own small stylesheet, then the window itself (previewWindow.ts).
 *
 * @module pages/FeedbackForms/preview/window/main
 */
import './previewWindow.css'
import { bootPreviewWindow } from './previewWindow'

void bootPreviewWindow(document.body)
