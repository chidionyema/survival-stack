// A QR code, with nothing installed. CoreImage ships with macOS, so this works
// on a laptop that has never seen homebrew. Round-tripped through CIDetector in
// test/incident-setup-console.test.js, because a QR that does not scan is worse
// than no QR at all.
ObjC.import('CoreImage'); ObjC.import('Foundation'); ObjC.import('AppKit')
function run(argv) {
  const text = argv[0], out = argv[1], scale = parseInt(argv[2] || '8', 10)
  const f = $.CIFilter.filterWithName('CIQRCodeGenerator')
  f.setValueForKey(
    $.NSString.alloc.initWithUTF8String(text).dataUsingEncoding($.NSISOLatin1StringEncoding),
    'inputMessage')
  f.setValueForKey($.NSString.alloc.initWithUTF8String('M'), 'inputCorrectionLevel')
  const img = f.outputImage.imageByApplyingTransform($.CGAffineTransformMakeScale(scale, scale))
  const rep = $.NSCIImageRep.imageRepWithCIImage(img)
  const ns = $.NSImage.alloc.initWithSize(rep.size)
  ns.addRepresentation(rep)
  const bm = $.NSBitmapImageRep.imageRepWithData(ns.TIFFRepresentation)
  const png = bm.representationUsingTypeProperties($.NSPNGFileType, $())
  png.writeToFileAtomically($.NSString.alloc.initWithUTF8String(out), true)
  return 'ok'
}
