// 스캔 PDF(텍스트 레이어 없는 각본)를 macOS Vision OCR로 읽어 '좌표가 있는 줄'로 뽑는다.
//   각본은 들여쓰기가 구조(지문 0 / 대사 중간 / 인물 깊숙이)라 글자만 뽑으면 쓸모가 없다.
//   그래서 인식된 각 줄의 x위치를 함께 출력해, text-reformat 이 들여쓰기로 복원할 수 있게 한다.
//
//   빌드: swiftc -O tools/ocr-vision.swift -o /tmp/ocr-vision
//   실행: /tmp/ocr-vision <입력.pdf> <출력.txt>
import Foundation
import Vision
import CoreGraphics
import ImageIO

let args = CommandLine.arguments
guard args.count >= 3 else {
    FileHandle.standardError.write("사용: ocr-vision <입력.pdf> <출력.txt>\n".data(using: .utf8)!)
    exit(1)
}
let inURL = URL(fileURLWithPath: args[1])
let outPath = args[2]

guard let doc = CGPDFDocument(inURL as CFURL) else {
    FileHandle.standardError.write("PDF를 열 수 없음\n".data(using: .utf8)!); exit(1)
}

var out = ""
let total = doc.numberOfPages
// 300dpi 상당으로 키워야 각본 고정폭 글꼴이 안정적으로 읽힌다
let scale: CGFloat = 300.0 / 72.0

for pageNo in 1...total {
    guard let page = doc.page(at: pageNo) else { continue }
    let box = page.getBoxRect(.mediaBox)
    let w = Int(box.width * scale), h = Int(box.height * scale)
    guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8,
                              bytesPerRow: 0, space: CGColorSpaceCreateDeviceGray(),
                              bitmapInfo: CGImageAlphaInfo.none.rawValue) else { continue }
    ctx.setFillColor(gray: 1, alpha: 1)
    ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
    ctx.scaleBy(x: scale, y: scale)
    ctx.translateBy(x: -box.origin.x, y: -box.origin.y)
    ctx.drawPDFPage(page)
    guard let img = ctx.makeImage() else { continue }

    let req = VNRecognizeTextRequest()
    req.recognitionLevel = .accurate
    req.usesLanguageCorrection = false      // 각본 고유명사·대문자 큐가 '교정'되면 오히려 망가진다
    req.recognitionLanguages = ["en-US"]
    let handler = VNImageRequestHandler(cgImage: img, options: [:])
    do { try handler.perform([req]) } catch { continue }

    guard let obs = req.results else { continue }
    // Vision 좌표는 좌하단 기준 0~1 — 위에서 아래로 읽도록 y 내림차순.
    // ★같은 줄이 여러 조각으로 인식되는 일이 흔하다. y만으로 정렬하면 조각 순서가 뒤엉켜
    //   'do when you get out What are you going to of here?' 처럼 어절이 뒤바뀐다.
    //   그래서 y가 비슷한 것끼리 한 줄로 묶고, 그 안에서는 x 오름차순으로 이어 붙인다.
    let raw = obs.compactMap { o -> (CGFloat, CGFloat, String)? in
        guard let t = o.topCandidates(1).first?.string, !t.isEmpty else { return nil }
        return (o.boundingBox.midY, o.boundingBox.minX, t)
    }.sorted { $0.0 > $1.0 }

    var lines: [(CGFloat, CGFloat, String)] = []
    let yTol: CGFloat = 0.006          // 한 줄로 볼 y 오차(페이지 높이 대비)
    for item in raw {
        if var last = lines.last, abs(last.0 - item.0) < yTol {
            // 같은 줄 — x 순서에 맞춰 끼워 넣는다
            if item.1 < last.1 { last = (last.0, item.1, item.2 + " " + last.2) }
            else { last = (last.0, last.1, last.2 + " " + item.2) }
            lines[lines.count - 1] = last
        } else {
            lines.append(item)
        }
    }

    for (_, x, text) in lines {
        // x비율을 '칸 수'로 환산 — 각본 한 줄이 대략 80칸이라는 통상 기준을 쓴다
        let indent = Int((x * 80).rounded())
        out += String(repeating: " ", count: max(0, indent)) + text + "\n"
    }
    out += "\n"
    if pageNo % 10 == 0 { FileHandle.standardError.write("  \(pageNo)/\(total)쪽\n".data(using: .utf8)!) }
}

try? out.write(toFile: outPath, atomically: true, encoding: .utf8)
FileHandle.standardError.write("→ \(outPath) (\(total)쪽)\n".data(using: .utf8)!)
