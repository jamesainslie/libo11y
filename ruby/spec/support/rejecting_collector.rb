# frozen_string_literal: true

require "webrick"

# An HTTP server that answers every OTLP request with one status, for tests
# of what libo11y reports when a collector rejects an export.
class RejectingCollector
  attr_reader :endpoint

  def initialize(status: 400)
    @server = WEBrick::HTTPServer.new(BindAddress: "127.0.0.1", Port: 0, Logger: WEBrick::Log.new(File::NULL), AccessLog: [])
    @endpoint = "http://127.0.0.1:#{@server.config[:Port]}"
    @requests = Queue.new
    @server.mount_proc("/") do |req, res|
      @requests << req.path
      res.status = status
      res.body = ""
    end
    @thread = Thread.new { @server.start }
  end

  # The paths of the requests received so far.
  def paths
    Array.new(@requests.size) { @requests.pop }
  end

  def stop
    @server.shutdown
    @thread.join(2)
  end
end
