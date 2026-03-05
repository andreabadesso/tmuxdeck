defmodule Relay.Tunnels.Protocol do
  @moduledoc """
  Binary frame protocol for multiplexing traffic over a single WebSocket tunnel.

  Frame format:
    <<stream_id::unsigned-32, frame_type::unsigned-8, payload::binary>>

  Frame types:
    0x01 = HTTP_REQUEST   { method, path, headers, body }
    0x02 = HTTP_RESPONSE  { status, headers, body }
    0x03 = WS_OPEN        { path, headers }
    0x04 = WS_DATA        { data }
    0x05 = WS_CLOSE       { code, reason }
    0x06 = STREAM_RESET   { reason }
    0x07 = PING
    0x08 = PONG
  """

  @http_request 0x01
  @http_response 0x02
  @ws_open 0x03
  @ws_data 0x04
  @ws_close 0x05
  @stream_reset 0x06
  @ping 0x07
  @pong 0x08

  def frame_type(:http_request), do: @http_request
  def frame_type(:http_response), do: @http_response
  def frame_type(:ws_open), do: @ws_open
  def frame_type(:ws_data), do: @ws_data
  def frame_type(:ws_close), do: @ws_close
  def frame_type(:stream_reset), do: @stream_reset
  def frame_type(:ping), do: @ping
  def frame_type(:pong), do: @pong

  def frame_type_atom(@http_request), do: :http_request
  def frame_type_atom(@http_response), do: :http_response
  def frame_type_atom(@ws_open), do: :ws_open
  def frame_type_atom(@ws_data), do: :ws_data
  def frame_type_atom(@ws_close), do: :ws_close
  def frame_type_atom(@stream_reset), do: :stream_reset
  def frame_type_atom(@ping), do: :ping
  def frame_type_atom(@pong), do: :pong
  def frame_type_atom(_), do: :unknown

  def encode_frame(stream_id, type, payload) when is_atom(type) do
    <<stream_id::unsigned-32, frame_type(type)::unsigned-8, payload::binary>>
  end

  def encode_frame(stream_id, type, payload) when is_integer(type) do
    <<stream_id::unsigned-32, type::unsigned-8, payload::binary>>
  end

  def decode_frame(<<stream_id::unsigned-32, type::unsigned-8, payload::binary>>) do
    {:ok, stream_id, frame_type_atom(type), payload}
  end

  def decode_frame(_), do: {:error, :invalid_frame}

  def encode_http_request(method, path, headers, body) do
    Jason.encode!(%{
      "method" => method,
      "path" => path,
      "headers" => headers,
      "body" => body |> Base.encode64()
    })
  end

  def decode_http_request(payload) do
    case Jason.decode(payload) do
      {:ok, %{"method" => method, "path" => path, "headers" => headers, "body" => body}} ->
        {:ok, method, path, headers, Base.decode64!(body)}

      {:ok, %{"method" => method, "path" => path, "headers" => headers}} ->
        {:ok, method, path, headers, ""}

      _ ->
        {:error, :invalid_http_request}
    end
  end

  def encode_http_response(status, headers, body) do
    Jason.encode!(%{
      "status" => status,
      "headers" => headers,
      "body" => body |> Base.encode64()
    })
  end

  def decode_http_response(payload) do
    case Jason.decode(payload) do
      {:ok, %{"status" => status, "headers" => headers, "body" => body}} ->
        {:ok, status, headers, Base.decode64!(body)}

      _ ->
        {:error, :invalid_http_response}
    end
  end
end
