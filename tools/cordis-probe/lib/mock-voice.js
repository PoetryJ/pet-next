/**
 * Mock 语音实现：把一段内置提示音当作"合成结果"返回。
 *
 * 存在意义是验证 `petApi7340.voice.register` 这条第三方注册入口——不联网、不依赖系统语音引擎，
 * 开关打开后 `POST /voice/speak` 会改走这里，点一下就听见一声「嘀」，说明链路通了。
 * 默认不注册：开关由本仓库的 `/cordis-probe-voice` 路由控制（见 ./voice-route.js）。
 * @module dsh-cordis-probe/mock-voice
 */

/** 660Hz、0.3 秒单声道 mp3（ffmpeg 生成后内嵌）：随包携带，不读外部文件、不联网。 */
const TEST_TONE_BASE64 =
  'SUQzBAAAAAAAIlRTU0UAAAAOAAADTGF2ZjYzLjEuMTAxAAAAAAAAAAAAAAD/81jAAAAAAAAAAAAASW5mbwAAAA8AAAALAAAFWAA1NTU1NTU1NTVKSkpKSkpKSkpeXl5eXl5eXl5ycnJycnJycnKGhoaGhoaGhoaampqampqampqvr6+vr6+vr6/Dw8PDw8PDw8PX19fX19fX19fr6+vr6+vr6+v///////////8AAAAATGF2YzYzLjEuAAAAAAAAAAAAAAAAJAPAAAAAAAAABVgx9R7nAAAAAAAAAAAAAAD/8zjEABTYrnANWGAAe2DluW5bluW5bvv/D7+Ow5DOGcNcdx/HIXeu+B1VAAg3UO1jowHICM7BMCYHxHJ5+/SixYsWOBiD4Pn8o6c5d+XDHAb9IY4DfznT/gM/3fyYIO0qgEAYAAt1AwGAwHD/8zjECxgZ+s5fjYADAAABPhGvCLCS+JaEV8yDrCwxQwmE2ECBdIAqCwoWaSpJYrJliURCpDhzhlv/HJFyitSHDnDnf/kyRUipkRYixj//l0umReLyKKKv//y8XkS6XVBUUlX//+f3///182D/8zjECReIkhgB3+AAAANLQmANABpgDwB6YA0AjmBqAhZgNADAEAehmubtyZXoNPmG1BIJg4QKebXhBuFqG7VYZFHVeXu7erHX+v/m69fZlUq0K78/fVX6+zev33bW7Ku2xqpkwAKyS3j/7/n/8zjECRTYiiIS3/bA//rv/E1oIJ1iF/zGiI0tXOcxjBfwn8ycxQFMqhCnTBkgOAwLMCPNZYzTlY1GpMlI0rIfpAcOe9HPP2zP3pf2+r+1VK/f//us//0V6wAKZFY/vO9/v//8/5SwItSYOEH/8zjEFBWoiiWU3/TAjI4ZIZmerRu1+YJKE1GPeJ3BkMITsYIwBQmAggCRgDZs2hyP5pC6a0O2jvzasex3trXm/tT1r//Vv36bv22/9/cowva38hgZfBuANjAoBgMMjUDJh2A1LATBkgyoyjv/8zjEHBMojhwAr/bAZSjLGg04wasEbMDGAqjanA2dfNqsDNCYv2/EvsA+7p//2dH31tc36v9P7/6W/f6fXf3/kODZQBQUBhAJgYqFoGPSEBmI3ga1chg1gW2ZYOuYmX4Bc5g0IFwYDsABiE//8zjELhKwjhwAr/bADPFk1u+MvLEBrvS3L/6fZ/+/2fqs32/72/oq/6X3t/IeHwA3PDMhAEQMID4DIKDA0dGDBZw3EySJtlMnrDkzBgASwwLsCtNtaTblI3ebM9HxYAfuWU+Bz/t/p1b/9av/8zjEQhOYkhwAr/bAu29HX/X68JW9H+6lCsP/mGGGH6ww+utNZ6JhgFARGCCBKYDoFohCSMSgYgyQETjji0aOoMh8xKRCTCDALAqGa+cmd0phg+Dhddc9SWCDde7i/so+r/q/b///99UACAD/8zjEUhOIkigBXtgAhFFHjACpFSMBTF/3UWHLUqVf5hCxcuEZYfoAwBAYDiwDRbAACIBAEAxWQFYBQEEcDsIuF8QbahYSKS8c8rmBcYSkIWIaOaMr+nfHKFzCtiGjmjK/mljdaZoTQ5w5xRL/8zjEYicCNn11mKgBKkVMv6CBummaIIG5FiLGJdLpkXi8j/00y4ggX00y4ggXy6XTIvF5Eul1IKv///5pBAekEB6QFhHCskxBTUUzLjEwMFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/8zjEJQAAA0gBwAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVU=';

/** 内置提示音的字节；每次返回新副本，调用方改它不会污染下一次。 */
export function testTone() {
  return new Uint8Array(Buffer.from(TEST_TONE_BASE64, 'base64'));
}

/**
 * 造一个 provider：不论文本与语速，一律回同一段提示音。
 * @returns 可直接交给 `voice.register` 的定义。
 */
export function createMockVoiceProvider() {
  return {
    id: 'mock-tone',
    name: 'Mock 提示音',
    async synthesize() {
      return testTone();
    },
  };
}
