import AppKit
import CoreText
import Foundation
import Vision

let mode = CommandLine.arguments[1]
let path = CommandLine.arguments[2]
if mode == "inspect" {
    let data = try Data(contentsOf: URL(fileURLWithPath: path))
    guard let bitmap = NSBitmapImageRep(data: data), let image = bitmap.cgImage,
          let marker = bitmap.colorAt(x: 950, y: 250)?.usingColorSpace(.deviceRGB) else {
        throw NSError(domain: "SmokeImageFixture", code: 1)
    }
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = false
    try VNImageRequestHandler(cgImage: image).perform([request])
    let result: [String: Any] = ["width": image.width, "height": image.height,
        "text": (request.results ?? []).compactMap { $0.topCandidates(1).first?.string },
        "marker": [marker.redComponent, marker.greenComponent, marker.blueComponent]]
    let json = try JSONSerialization.data(withJSONObject: result)
    print(String(decoding: json, as: UTF8.self))
} else {
    guard let context = CGContext(data: nil, width: 1024, height: 512,
                                  bitsPerComponent: 8, bytesPerRow: 0,
                                  space: CGColorSpaceCreateDeviceRGB(),
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
        throw NSError(domain: "SmokeImageFixture", code: 2)
    }
    context.setFillColor(CGColor(gray: 1, alpha: 1))
    context.fill(CGRect(x: 0, y: 0, width: 1024, height: 512))
    if mode == "text" {
        context.setFillColor(CGColor(red: 0, green: 0, blue: 1, alpha: 1))
        context.fill(CGRect(x: 900, y: 0, width: 124, height: 512))
        let text = NSAttributedString(string: "TOKEN-FOR-TESTS-KEPT", attributes: [
            .font: NSFont.systemFont(ofSize: 42), .foregroundColor: NSColor.black])
        context.textPosition = CGPoint(x: 50, y: 300)
        CTLineDraw(CTLineCreateWithAttributedString(text as CFAttributedString), context)
    }
    guard let image = context.makeImage(),
          let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else {
        throw NSError(domain: "SmokeImageFixture", code: 3)
    }
    try png.write(to: URL(fileURLWithPath: path), options: .atomic)
}
