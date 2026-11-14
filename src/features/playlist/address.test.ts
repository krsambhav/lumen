import { describe, expect, it } from "vitest";
import { readAddress, shortAddress } from "./address";

describe("readAddress", () => {
  it("takes a full address as it is", () => {
    expect(readAddress("  https://www.youtube.com/watch?v=dQw4w9WgXcQ \n")).toBe(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    );
    expect(readAddress("rtsp://10.0.0.4:554/live")).toBe("rtsp://10.0.0.4:554/live");
  });

  it("takes a site's name without a scheme as https", () => {
    expect(readAddress("vimeo.com/76979871")).toBe("https://vimeo.com/76979871");
    expect(readAddress("www.example.org")).toBe("https://www.example.org");
  });

  it("is not fooled by words, times, file names or paths", () => {
    for (const text of [
      "",
      "solaris",
      "1:23:45",
      "Film.mkv",
      "example.org",
      "/Users/me/Film.mp4",
      "file:///a.mp4",
      "two words.com",
      "https://",
    ]) {
      expect(readAddress(text)).toBeNull();
    }
  });
});

describe("shortAddress", () => {
  it("drops the scheme, www. and a trailing slash", () => {
    expect(shortAddress("https://www.example.org/")).toBe("example.org");
    expect(shortAddress("rtsp://cam/live")).toBe("rtsp://cam/live");
  });
});
