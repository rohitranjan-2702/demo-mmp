export {};

interface Body {
  id: number;
  event_type: string;
  user_id: number;
  page: string;
  country: string;
  duration_ms: number;
}

const main = async () => {
  const event_type = ["pageview", "click"];
  let user_id = 1;
  let id = 1;
  const page = ["/home", "/user", "/dashboard", "/settings"];
  const country = ["India", "USA", "Japan", "China", "Nepal"];

  let maxEvents = 150;

  const url = "http://localhost:3000/event";

  async function sendData(payload: Body) {
    try {
      const response = await fetch(url, {
        method: "POST", // Specifies the request type
        headers: {
          "Content-Type": "application/json", // Instructs server to expect JSON data
        },
        body: JSON.stringify(payload), // Converts JavaScript object to JSON string
      });

      // Check if the server returned a successful status code (200-299)
      if (!response.ok) {
        throw new Error(`HTTP error! Status: ${response.status}`);
      }

      const data = await response.json(); // Parses the JSON response body
      console.log("Success:", data);
    } catch (error) {
      console.error("Error during fetch:", error);
    }
  }

  while (maxEvents >= 3) {
    await Promise.all([
      sendData({
        id: id + 1,
        user_id: user_id + 1,
        country: country[2],
        page: page[2],
        duration_ms: Math.floor(Math.random() * 10000),
        event_type: event_type[0],
      }),
      sendData({
        id: id + 2,
        user_id: user_id + 2,
        country: country[3],
        page: page[1],
        duration_ms: Math.floor(Math.random() * 10000),
        event_type: event_type[1],
      }),
      sendData({
        id: id + 3,
        user_id: user_id + 3,
        country: country[2],
        page: page[2],
        duration_ms: Math.floor(Math.random() * 10000),
        event_type: event_type[1],
      }),
    ]);

    id = id + 3;
    user_id = user_id + 3;
    maxEvents = maxEvents - 3;
  }
};

main().catch((err) => console.log(err));
