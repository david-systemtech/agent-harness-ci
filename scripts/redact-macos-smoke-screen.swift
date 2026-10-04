import AppKit
import Foundation
import Vision

// Raw screenshots stay outside the upload directory. Mask all OCR text; dialog
// owners/titles are available separately in the credential-redacted window list.
guard CommandLine.arguments.count == 3,
      let bitmap = NSBitmapImageRep(contentsOfFile: CommandLine.arguments[1]),
      let image = bitmap.cgImage else {
    throw NSError(domain: "SmokeScreenshot", code: 1)
}
let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = false
try VNImageRequestHandler(cgImage: image).perform([request])
guard let regions = request.results, !regions.isEmpty else {
    // Do not upload an unchanged image when recognition yielded no safe mask.
    throw NSError(domain: "SmokeScreenshot", code: 4)
}
let width = CGFloat(image.width)
let height = CGFloat(image.height)
guard let context = CGContext(data: nil, width: image.width, height: image.height,
                              bitsPerComponent: 8, bytesPerRow: 0,
                              space: CGColorSpaceCreateDeviceRGB(),
                              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
    throw NSError(domain: "SmokeScreenshot", code: 2)
}
context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
context.setFillColor(CGColor(gray: 0, alpha: 1))
for region in regions {
    let box = region.boundingBox
    context.fill(CGRect(x: box.minX * width - 4, y: box.minY * height - 4,
                        width: box.width * width + 8, height: box.height * height + 8))
}
guard let redacted = context.makeImage(),
      let png = NSBitmapImageRep(cgImage: redacted).representation(using: .png, properties: [:]) else {
    throw NSError(domain: "SmokeScreenshot", code: 3)
}
try png.write(to: URL(fileURLWithPath: CommandLine.arguments[2]), options: .atomic)
