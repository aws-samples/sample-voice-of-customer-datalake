const Index = () => {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="text-center">
        <h1 className="font-display text-6xl md:text-8xl font-medium text-foreground animate-fade-up">
          Hello World
        </h1>
        <p className="mt-6 font-body text-lg text-muted-foreground animate-fade-in" style={{ animationDelay: '0.3s' }}>
          Welcome to your new app
        </p>
      </div>
    </div>
  );
};

export default Index;
